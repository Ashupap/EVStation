import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from '../src/lib/rate-limit.js';

describe('fixed-window rate limiter', () => {
  it('rejects requests above the limit and reports a retry delay', () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    expect(limiter.check('ip', 1_000).allowed).toBe(true);
    expect(limiter.check('ip', 1_001).allowed).toBe(true);
    const rejected = limiter.check('ip', 1_002);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBe(60);
    expect(limiter.check('other', 1_002).allowed).toBe(true);
  });

  it('resets after the window and caps tracked keys', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000, 2);
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('b', 0).allowed).toBe(true);
    expect(limiter.check('c', 0).allowed).toBe(true);
    expect(limiter.check('a', 1_001).allowed).toBe(true);
  });
});
