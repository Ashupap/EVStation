import { randomBytes } from 'node:crypto';

export interface SessionRecord {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accessExpiresAt: number;
  absoluteExpiresAt: number;
  tenantId?: string;
}

export interface NewSessionRecord {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accessExpiresAt: number;
  absoluteExpiresAt: number;
  tenantId?: string;
}

export interface SessionStore {
  create(record: NewSessionRecord): string;
  get(id: string): SessionRecord | undefined;
  update(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined;
  delete(id: string): void;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(record: NewSessionRecord): string {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { ...record });
    return id;
  }

  get(id: string): SessionRecord | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    if (record.absoluteExpiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return { ...record };
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const updated = { ...current, ...patch };
    this.sessions.set(id, updated);
    return { ...updated };
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}

const globalSessions = globalThis as typeof globalThis & {
  __evstationSessionStore?: InMemorySessionStore;
};

export function getSessionStore(): InMemorySessionStore {
  globalSessions.__evstationSessionStore ??= new InMemorySessionStore();
  return globalSessions.__evstationSessionStore;
}
