/**
 * In-memory sliding-window rate limiter keyed by an arbitrary string (e.g. client IP).
 * Bounded: keys are kept in least-recently-hit order, expired keys are swept at most once per second
 * once the map is large, and the oldest keys are evicted past MAX_KEYS — so a caller rotating keys
 * (forged addresses on an unauthenticated route) cannot make every check O(N) with N unbounded.
 */
export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterMs: number };

const SWEEP_ABOVE_KEYS = 1000;
const SWEEP_EVERY_MS = 1000;
const MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    if (max < 1 || windowMs < 1) throw new Error('RateLimiter needs max >= 1 and windowMs >= 1');
  }

  /** Records the attempt when allowed; over the limit the attempt is not recorded. */
  check(key: string, now = Date.now()): RateLimitResult {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    let result: RateLimitResult;
    if (recent.length >= this.max) {
      const oldest = recent[0] ?? now;
      result = { ok: false, retryAfterMs: Math.max(1, this.windowMs - (now - oldest)) };
    } else {
      recent.push(now);
      result = { ok: true, remaining: this.max - recent.length };
    }
    // re-insert so Map iteration order is least-recently-hit first (cheap LRU for eviction)
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > SWEEP_ABOVE_KEYS && now - this.lastSweep >= SWEEP_EVERY_MS) this.sweep(now);
    if (this.hits.size > MAX_KEYS) this.evict(this.hits.size - MAX_KEYS);
    return result;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** number of tracked keys (for tests) */
  get size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [k, ts] of this.hits) {
      if (!ts.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
  }

  private evict(count: number): void {
    for (const k of this.hits.keys()) {
      if (count-- <= 0) break;
      this.hits.delete(k);
    }
  }
}
