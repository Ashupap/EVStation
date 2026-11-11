import { randomBytes } from 'node:crypto';

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

export interface SessionRecord {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accessExpiresAt: number;
  absoluteExpiresAt: number;
  lastSeenAt: number;
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

export interface SessionStoreOptions {
  idleTtlMs?: number;
  maxEntries?: number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: SessionStoreOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private expired(record: SessionRecord, now: number): boolean {
    return record.absoluteExpiresAt <= now || record.lastSeenAt + this.idleTtlMs <= now;
  }

  private sweep(now: number): void {
    for (const [id, record] of this.sessions) {
      if (this.expired(record, now)) this.sessions.delete(id);
    }
  }

  create(record: NewSessionRecord): string {
    const now = Date.now();
    this.sweep(now);
    while (this.sessions.size >= this.maxEntries) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { ...record, lastSeenAt: now });
    return id;
  }

  get(id: string): SessionRecord | undefined {
    const now = Date.now();
    const record = this.sessions.get(id);
    if (!record) return undefined;
    if (this.expired(record, now)) {
      this.sessions.delete(id);
      return undefined;
    }
    record.lastSeenAt = now;
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

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const globalSessions = globalThis as typeof globalThis & {
  __evstationSessionStore?: InMemorySessionStore;
};

export function getSessionStore(): InMemorySessionStore {
  globalSessions.__evstationSessionStore ??= new InMemorySessionStore({
    idleTtlMs: positiveInt(process.env.SESSION_IDLE_TTL_SECONDS, 1800) * 1000,
    maxEntries: positiveInt(process.env.SESSION_STORE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES),
  });
  return globalSessions.__evstationSessionStore;
}
