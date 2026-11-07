import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtVerifier } from '../src/auth.js';

const ISSUER = 'http://keycloak.test/realms/evstation';
const AUDIENCE = 'evstation-api';

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keySet: JWTVerifyGetKey;

async function sign(
  key: CryptoKey,
  claims: Record<string, unknown> = {},
  options: {
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    subject?: string;
  } = {},
) {
  return new SignJWT({ email: 'user@example.com', email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject(options.subject ?? '00000000-0000-4000-8000-000000000001')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(key);
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = other.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256' }] });
});

describe('JWT verification', () => {
  it('accepts a correctly signed token with issuer/audience', async () => {
    const verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet });
    const claims = await verifier.verify(await sign(privateKey));
    expect(claims).toMatchObject({
      sub: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      email_verified: true,
    });
  });

  it('rejects wrong audience, issuer, expiry, and signature', async () => {
    const verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet });
    await expect(
      verifier.verify(await sign(privateKey, {}, { audience: 'other' })),
    ).rejects.toThrow();
    await expect(
      verifier.verify(await sign(privateKey, {}, { issuer: 'http://evil.test' })),
    ).rejects.toThrow();
    await expect(verifier.verify(await sign(privateKey, {}, { expiresIn: -10 }))).rejects.toThrow();
    await expect(verifier.verify(await sign(otherKey))).rejects.toThrow();
  });

  it('requires email and subject claims, and a UUID subject', async () => {
    const verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, keySet });
    const noEmail = await sign(privateKey, { email: undefined });
    await expect(verifier.verify(noEmail)).rejects.toThrow(/email/);
    const nonUuid = await sign(privateKey, {}, { subject: 'not-a-uuid' });
    await expect(verifier.verify(nonUuid)).rejects.toThrow(/UUID/);
  });
});
