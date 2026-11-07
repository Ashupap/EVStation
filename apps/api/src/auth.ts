import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    claims?: TokenClaims;
  }
}

export interface TokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  preferred_username?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TokenVerifier {
  verify(token: string): Promise<TokenClaims>;
}

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri?: string;
  keySet?: JWTVerifyGetKey;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

export function createJwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  const keySet =
    options.keySet ??
    (options.jwksUri
      ? createRemoteJWKSet(new URL(options.jwksUri))
      : createLocalJWKSet({ keys: [] }));

  return {
    async verify(token: string): Promise<TokenClaims> {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256'],
      });
      if (typeof payload.sub !== 'string' || !UUID_PATTERN.test(payload.sub)) {
        throw new AppError(401, 'UNAUTHORIZED', 'token subject must be a UUID');
      }
      if (typeof payload.email !== 'string' || payload.email.length === 0) {
        throw new AppError(401, 'UNAUTHORIZED', 'token is missing an email');
      }
      return {
        sub: payload.sub,
        email: payload.email,
        email_verified: asBoolean(payload.email_verified),
        ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
        ...(typeof payload.preferred_username === 'string'
          ? { preferred_username: payload.preferred_username }
          : {}),
      };
    },
  };
}

export async function authenticate(
  verifier: TokenVerifier,
  authorization: string | undefined,
): Promise<TokenClaims> {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    throw new AppError(401, 'UNAUTHORIZED', 'missing bearer token');
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new AppError(401, 'UNAUTHORIZED', 'missing bearer token');
  try {
    return await verifier.verify(token);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'UNAUTHORIZED', 'invalid or expired token');
  }
}
