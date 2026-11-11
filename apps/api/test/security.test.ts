import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createJwtVerifier } from '../src/auth.js';
import { loadConfig, type ApiConfig } from '../src/config.js';
import type { ApiDb } from '../src/db.js';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('tenant context writes', () => {
  it('uses set_config only in the request-context module, always transaction-local', () => {
    const matches = sourceFiles(join(import.meta.dirname, '..', 'src')).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source
        .split('\n')
        .map((line, index) => ({ file, line: line.trim(), number: index + 1 }))
        .filter((entry) => entry.line.includes('set_config('));
    });

    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.file.endsWith('/context.ts'), `${match.file}:${match.number}`).toBe(true);
      expect(match.line, `${match.file}:${match.number}`).toMatch(/, true\)/);
    }
  });
});

describe('database role URLs', () => {
  const base = {
    DATABASE_URL_APP: 'postgres://evstation_app:pw@localhost:5432/evstation',
    OIDC_ISSUER: 'http://localhost:8180/realms/evstation',
  };

  it('rejects DATABASE_URL_OWNER because the API runtime must never use it', () => {
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL_OWNER: 'postgres://evstation_owner:pw@localhost:5432/evstation',
      }),
    ).toThrow(/DATABASE_URL_OWNER/);
  });

  it('rejects DATABASE_URL_MIGRATOR because the API runtime must never use it', () => {
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL_MIGRATOR: 'postgres://evstation:pw@localhost:5432/evstation',
      }),
    ).toThrow(/DATABASE_URL_MIGRATOR/);
  });

  it('accepts runtime configuration without owner or migrator URLs', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv)).toMatchObject({
      databaseUrlApp: base.DATABASE_URL_APP,
      host: '127.0.0.1',
      trustProxy: false,
    });
  });

  it('accepts explicit HOST and a bounded proxy hop count', () => {
    expect(loadConfig({ ...base, HOST: '0.0.0.0' } as NodeJS.ProcessEnv).host).toBe('0.0.0.0');
    expect(loadConfig({ ...base, TRUST_PROXY: '2' } as NodeJS.ProcessEnv).trustProxy).toBe(2);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '11' } as NodeJS.ProcessEnv)).toThrow(
      /TRUST_PROXY hop count/,
    );
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' } as NodeJS.ProcessEnv)).toThrow(
      /hop count or a comma-separated/,
    );
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'yes' } as NodeJS.ProcessEnv)).toThrow(
      /TRUST_PROXY/,
    );
  });

  it('accepts an explicit trusted proxy/CIDR list', () => {
    expect(
      loadConfig({
        ...base,
        TRUST_PROXY: '127.0.0.1, 10.0.0.0/8,::1',
      } as NodeJS.ProcessEnv).trustProxy,
    ).toEqual(['127.0.0.1', '10.0.0.0/8', '::1']);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/33' } as NodeJS.ProcessEnv)).toThrow(
      /invalid CIDR/,
    );
    expect(() =>
      loadConfig({ ...base, TRUST_PROXY: 'proxy.internal' } as NodeJS.ProcessEnv),
    ).toThrow(/invalid address/);
  });

  it('requires https OIDC issuer and JWKS in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /OIDC_ISSUER must use https/,
    );
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        OIDC_ISSUER: 'https://keycloak.example/realms/evstation',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('does not advertise owner or migrator URLs in .env.example', () => {
    const content = readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8');
    expect(content).not.toContain('DATABASE_URL_OWNER');
    expect(content).not.toContain('DATABASE_URL_MIGRATOR');
  });
});

describe('JWT failures over HTTP', () => {
  const ISSUER = 'http://keycloak.test/realms/evstation';
  const AUDIENCE = 'evstation-api';
  let expiredToken: string;
  let wrongKeyToken: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    const other = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(pair.publicKey);
    const keySet = createLocalJWKSet({
      keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256' }],
    });
    const sign = (key: CryptoKey, expiresIn: string | number) =>
      new SignJWT({ email: 'user@example.com', email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('00000000-0000-4000-8000-000000000001')
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(key);
    expiredToken = await sign(pair.privateKey, -10);
    wrongKeyToken = await sign(other.privateKey, '5m');

    const config: ApiConfig = {
      nodeEnv: 'test',
      port: 0,
      host: '127.0.0.1',
      trustProxy: false,
      logLevel: 'silent',
      databaseUrlApp: '',
      oidcIssuer: ISSUER,
      oidcAudience: AUDIENCE,
      oidcJwksUri: `${ISSUER}/certs`,
      invitationAcceptBaseUrl: 'http://localhost:3200/invitations/accept',
    };
    const db = {
      pool: {},
      transaction: async () => {
        throw new Error('database must not be reached');
      },
      query: async () => {
        throw new Error('database must not be reached');
      },
      close: async () => undefined,
    } as unknown as ApiDb;
    app = await buildApp({
      db,
      config,
      verifier: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet }),
      logger: false,
    });
    await app.ready();
  });

  it('rejects expired and wrong-signature tokens with 401', async () => {
    for (const token of [expiredToken, wrongKeyToken]) {
      const response = await app.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });
});
