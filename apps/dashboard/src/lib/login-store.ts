import { randomBytes } from 'node:crypto';

const DEFAULT_MAX_ENTRIES = 5_000;

export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface LoginStore {
  create(transaction: LoginTransaction): string;
  consume(id: string): LoginTransaction | undefined;
  delete(id: string): void;
}

export interface LoginStoreOptions {
  maxEntries?: number;
}

export class InMemoryLoginStore implements LoginStore {
  private readonly transactions = new Map<string, LoginTransaction>();
  private readonly maxEntries: number;

  constructor(options: LoginStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private sweep(now: number): void {
    for (const [id, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(id);
    }
  }

  create(transaction: LoginTransaction): string {
    const now = Date.now();
    this.sweep(now);
    while (this.transactions.size >= this.maxEntries) {
      const oldest = this.transactions.keys().next().value;
      if (oldest === undefined) break;
      this.transactions.delete(oldest);
    }
    const id = randomBytes(32).toString('base64url');
    this.transactions.set(id, { ...transaction });
    return id;
  }

  consume(id: string): LoginTransaction | undefined {
    const transaction = this.transactions.get(id);
    this.transactions.delete(id);
    if (!transaction || transaction.expiresAt <= Date.now()) return undefined;
    return { ...transaction };
  }

  delete(id: string): void {
    this.transactions.delete(id);
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const globalLogins = globalThis as typeof globalThis & {
  __evstationLoginStore?: InMemoryLoginStore;
};

export function getLoginStore(): InMemoryLoginStore {
  globalLogins.__evstationLoginStore ??= new InMemoryLoginStore({
    maxEntries: positiveInt(process.env.LOGIN_STORE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
  });
  return globalLogins.__evstationLoginStore;
}
