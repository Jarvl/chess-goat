/** At most four open SSE streams per user. */
export class StreamGate {
  private readonly open = new Map<number, number>();

  constructor(private readonly max = 4) {}

  count(userId: number): number {
    return this.open.get(userId) ?? 0;
  }

  acquire(userId: number): boolean {
    const current = this.count(userId);
    if (current >= this.max) return false;
    this.open.set(userId, current + 1);
    return true;
  }

  release(userId: number): void {
    const current = this.count(userId);
    if (current <= 1) this.open.delete(userId);
    else this.open.set(userId, current - 1);
  }
}
