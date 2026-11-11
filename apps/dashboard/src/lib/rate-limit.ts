const DEFAULT_MAX_ENTRIES = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(limit: number, windowMs: number, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      if (this.buckets.size >= this.maxEntries) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count += 1;
    if (current.count <= this.limit) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
}

const globalLimits = globalThis as typeof globalThis & {
  __evstationLoginLimit?: FixedWindowRateLimiter;
  __evstationCallbackLimit?: FixedWindowRateLimiter;
};

export function getLoginRateLimiter(): FixedWindowRateLimiter {
  globalLimits.__evstationLoginLimit ??= new FixedWindowRateLimiter(60, 60_000);
  return globalLimits.__evstationLoginLimit;
}

export function getCallbackRateLimiter(): FixedWindowRateLimiter {
  globalLimits.__evstationCallbackLimit ??= new FixedWindowRateLimiter(30, 60_000);
  return globalLimits.__evstationCallbackLimit;
}
