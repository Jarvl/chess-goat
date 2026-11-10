/**
 * A per-owner cap on something held open: listen streams in the routes (per lease on the turn
 * surface).
 * Counts live in memory; a slot is held until its release function is called.
 */
export class OwnerGate {
  private readonly open = new Map<number, number>();

  constructor(private readonly perOwner: number) {}

  /** A release function (idempotent), or null when the owner already holds `perOwner` slots. */
  acquire(ownerId: number): (() => void) | null {
    const count = this.open.get(ownerId) ?? 0;
    if (count >= this.perOwner) return null;
    this.open.set(ownerId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(ownerId) ?? 1) - 1;
      if (left > 0) this.open.set(ownerId, left);
      else this.open.delete(ownerId);
    };
  }
}
