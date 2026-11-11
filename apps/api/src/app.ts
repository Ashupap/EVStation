import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { writeDeniedAudit } from './audit.js';
import { authenticate, type TokenVerifier } from './auth.js';
import type { ApiConfig } from './config.js';
import { setActorContext } from './context.js';
import type { ApiDb } from './db.js';
import { AppError, errorHandler, toErrorBody } from './errors.js';
import { MemoryMailer, type Mailer } from './mailer.js';
import { loadPrincipal, resolveTenant, type Principal } from './principal.js';
import { requireCapability } from './authorize.js';
import {
  registerRoutes,
  tenantForRequest,
  type RouteDefinition,
  type RouteDispatcher,
} from './routes.js';

export interface RegisteredRoute {
  method: string | string[];
  url: string;
}

export interface BuildAppOptions {
  db: ApiDb;
  config: ApiConfig;
  verifier: TokenVerifier;
  mailer?: Mailer;
  rateLimit?: { max?: number; ipMax?: number; timeWindow?: number };
  logger?: boolean;
  logStream?: NodeJS.WritableStream;
  onRoute?: (route: RegisteredRoute) => void;
}

export const SERVICE_NAME = 'evstation-api';
export const BODY_LIMIT_BYTES = 64 * 1024;

function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/health/ready' ||
    pathname === '/openapi.json' ||
    pathname === '/docs' ||
    pathname.startsWith('/docs/')
  );
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, config, verifier } = options;
  const mailer = options.mailer ?? new MemoryMailer();
  if (config.nodeEnv === 'production' && !options.mailer) {
    throw new Error('a mailer is required in production');
  }
  const docsEnabled = config.nodeEnv === 'development';
  const trustProxy =
    typeof config.trustProxy === 'number'
      ? (_address: string, hop: number) => hop < (config.trustProxy as number)
      : config.trustProxy;
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            ...(options.logStream ? { stream: options.logStream } : {}),
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'err.detail',
                'err.where',
                'err.internalQuery',
                'err.query',
              ],
              censor: '[REDACTED]',
            },
          },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
  });

  db.setPoolErrorLogger?.((event) => {
    app.log.error(event, 'database pool error');
  });

  const afterResponseTasks = new WeakMap<FastifyRequest, Array<() => Promise<void>>>();
  app.addHook('onResponse', (request, reply, done) => {
    const tasks = afterResponseTasks.get(request);
    afterResponseTasks.delete(request);
    if (!tasks || tasks.length === 0) {
      done();
      return;
    }
    setImmediate(() => {
      void (async () => {
        for (const task of tasks) {
          try {
            await task();
          } catch {
            request.log.error({ task: 'after-response' }, 'after-response task failed');
          }
        }
      })();
    });
    done();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  if (options.onRoute) app.addHook('onRoute', options.onRoute);

  if (docsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'EVStation API',
          version: '0.1.0',
          description: 'Phase 1 auth/tenancy API. Bearer JWT; one transaction per request.',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.get('/openapi.json', async () => app.swagger());
  }

  const actorMax = options.rateLimit?.max ?? 100;
  const ipMax = options.rateLimit?.ipMax ?? 3_000;
  const rateLimitWindow = options.rateLimit?.timeWindow ?? 60_000;

  await app.register(rateLimit, {
    global: true,
    max: ipMax,
    timeWindow: rateLimitWindow,
    nameSpace: 'evstation-ip-',
    errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'too many requests'),
  });

  app.addHook('preParsing', async (request) => {
    const pathname = request.url.split('?', 1)[0] ?? '';
    if (isPublicPath(pathname)) return;
    request.claims = await authenticate(verifier, request.headers.authorization);
  });

  await app.register(rateLimit, {
    global: true,
    hook: 'preValidation',
    max: actorMax,
    timeWindow: rateLimitWindow,
    nameSpace: 'evstation-actor-',
    keyGenerator: (request) => request.claims?.sub ?? request.ip,
    errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'too many requests'),
  });

  app.get('/health', async () => ({ status: 'ok', service: SERVICE_NAME }));
  app.get('/health/ready', async () => {
    await db.query('SELECT 1');
    return { status: 'ready', service: SERVICE_NAME };
  });

  const dispatch: RouteDispatcher = async (
    definition: RouteDefinition,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const claims = request.claims;
    if (!claims) throw new AppError(401, 'UNAUTHORIZED', 'missing bearer token');
    const requestedTenantId = tenantForRequest(definition, request);
    let principal: Principal | undefined;
    const afterCommitTasks: Array<() => Promise<void>> = [];

    try {
      const result = await db.transaction(async (client) => {
        await setActorContext(client, claims.sub);
        principal = await loadPrincipal(client, claims);
        const tenantId = await resolveTenant(
          client,
          principal,
          requestedTenantId,
          definition.tenantSource !== 'none',
        );
        const siteId =
          definition.capability === 'site.update' &&
          typeof (request.params as { id?: unknown } | undefined)?.id === 'string'
            ? (request.params as { id: string }).id
            : undefined;
        requireCapability(principal, tenantId, definition.capability, { siteId });
        return definition.handler({
          request,
          reply,
          client,
          db,
          principal,
          tenantId,
          config,
          mailer,
          afterCommit: (task) => afterCommitTasks.push(task),
        });
      });
      if (afterCommitTasks.length > 0) afterResponseTasks.set(request, afterCommitTasks);
      return result;
    } catch (error) {
      if (principal && toErrorBody(error).status === 403) {
        await writeDeniedAudit(db, principal, {
          action: definition.auditAction ?? `${definition.method} ${definition.url}`,
          resourceType: definition.url.split('/')[1],
          requestId: request.id,
          attemptedTenantId: requestedTenantId,
        });
      }
      throw error;
    }
  };

  registerRoutes(app, dispatch);

  app.setNotFoundHandler(async (_request, reply) => {
    void reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
  });

  return app;
}
