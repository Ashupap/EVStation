import { CsmsError } from './types.js';
import type { TokenProvider } from './token.js';

export class HasuraClient {
  constructor(
    private readonly url: string,
    private readonly token: TokenProvider,
  ) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await this.token.get()}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json()) as { data?: T; errors?: unknown[] };
    if (!response.ok || body.errors || !body.data) {
      throw new CsmsError('CitrineOS Hasura request failed', 'CSMS_UNAVAILABLE');
    }
    return body.data;
  }
}
