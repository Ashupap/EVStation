import { CsmsError } from './types.js';

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class TokenProvider {
  private cached?: CachedToken;
  constructor(
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 30_000) return this.cached.value;
    const response = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!response.ok) throw new CsmsError('CSMS service token rejected', 'CSMS_AUTH');
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new CsmsError('CSMS service token missing', 'CSMS_AUTH');
    this.cached = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(30, body.expires_in ?? 60) * 1000,
    };
    return body.access_token;
  }
}

export async function localDevToken(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roles: ['admin'] }),
  });
  if (!response.ok) throw new CsmsError('CitrineOS localDev token rejected', 'CSMS_AUTH');
  const body = (await response.json()) as { accessToken?: string };
  if (!body.accessToken) throw new CsmsError('CitrineOS localDev token missing', 'CSMS_AUTH');
  return body.accessToken;
}
