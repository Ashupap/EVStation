import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
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
import { AppError, errorHandler } from './errors.js';
import { loadPrincipal, resolveTenant, type Principal } from './principal.js';
import {
  registerRoutes,
  tenantForRequest,
  type RouteDefinition,
  type RouteDispatcher,
} from './routes.js';

export interface BuildAppOptions {
  db: ApiDb;
  config: ApiConfig;
  verifier: TokenVerifier;
  logger?: boolean;
}

export const SERVICE_NAME = 'evstation-api';

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, config, verifier } = options;
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    disableRequestLogging: true,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

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
    const claims = await authenticate(verifier, request.headers.authorization);
    const requestedTenantId = tenantForRequest(definition, request);
    let principal: Principal | undefined;

    try {
      return await db.transaction(async (client) => {
        await setActorContext(client, claims.sub);
        principal = await loadPrincipal(client, claims);
        const tenantId = await resolveTenant(
          client,
          principal,
          requestedTenantId,
          definition.tenantSource !== 'none',
        );
        return definition.handler({
          request,
          reply,
          client,
          principal,
          tenantId,
          config,
        });
      });
    } catch (error) {
      if (principal && error instanceof AppError && error.statusCode === 403) {
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
