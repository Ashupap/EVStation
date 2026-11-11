import { randomBytes } from 'node:crypto';

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

export class InMemoryLoginStore implements LoginStore {
  private readonly transactions = new Map<string, LoginTransaction>();

  create(transaction: LoginTransaction): string {
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

const globalLogins = globalThis as typeof globalThis & {
  __evstationLoginStore?: InMemoryLoginStore;
};

export function getLoginStore(): InMemoryLoginStore {
  globalLogins.__evstationLoginStore ??= new InMemoryLoginStore();
  return globalLogins.__evstationLoginStore;
}
