import { CsmsError } from './types.js';
import type { TokenProvider } from './token.js';

export class HasuraClient {
  constructor(
    private readonly url: string,
    private readonly token: TokenProvider,
    private readonly timeoutMs = 10_000,
  ) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.token.get()}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await response.json()) as {
      data?: T;
      errors?: Array<{ extensions?: { code?: string } }>;
    };
    if (!response.ok || body.errors || !body.data) {
      const code = body.errors?.find((error) => error.extensions?.code)?.extensions?.code;
      if (code) console.error('csms_hasura_error', { code });
      throw new CsmsError('CitrineOS Hasura request failed', 'CSMS_UNAVAILABLE');
    }
    return body.data;
  }
}
