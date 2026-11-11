import * as client from 'openid-client';
import { loadDashboardConfig } from './config';

let cachedConfig: client.Configuration | undefined;

export async function getOidcConfig(): Promise<client.Configuration> {
  if (cachedConfig) return cachedConfig;
  const config = loadDashboardConfig();
  const issuer = new URL(config.oidcIssuer);
  cachedConfig = await client.discovery(
    issuer,
    config.oidcClientId,
    config.oidcClientSecret,
    undefined,
    issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined,
  );
  return cachedConfig;
}

export async function buildLoginUrl(): Promise<{
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}> {
  const config = loadDashboardConfig();
  const oidc = await getOidcConfig();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const url = client.buildAuthorizationUrl(oidc, {
    redirect_uri: config.oidcRedirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url, state, nonce, codeVerifier };
}

export async function exchangeCode(
  currentUrl: URL,
  transaction: { state: string; nonce: string; codeVerifier: string },
): Promise<client.TokenEndpointResponse & client.TokenEndpointResponseHelpers> {
  return client.authorizationCodeGrant(await getOidcConfig(), currentUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.codeVerifier,
  });
}

export async function refreshTokens(
  refreshToken: string,
): Promise<client.TokenEndpointResponse & client.TokenEndpointResponseHelpers> {
  return client.refreshTokenGrant(await getOidcConfig(), refreshToken);
}

export async function revokeToken(token: string): Promise<void> {
  await client.tokenRevocation(await getOidcConfig(), token, {
    token_type_hint: 'refresh_token',
  });
}
