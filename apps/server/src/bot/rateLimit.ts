/** Sliding-window limiter kept in memory; one process at v1 (spec §4.3), so no table is needed. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Test seam: how many keys it holds, so a test can show old ones are pruned. */
  get size(): number {
    return this.hits.size;
  }

  allow(key: string, now: number = Date.now()): boolean {
    this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  reset(): void {
    this.hits.clear();
  }

  /** Drops keys whose every hit left the window, at most once per window, so the map stays bounded. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, hits] of this.hits) {
      if (hits.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }
}
