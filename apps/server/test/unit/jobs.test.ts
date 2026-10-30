import { describe, expect, it } from 'vitest';
import { pollBackoffMs } from '../../src/jobs/worker';

describe('pollBackoffMs', () => {
  it('doubles the poll interval per consecutive failure up to a minute', () => {
    expect(pollBackoffMs(1_000, 0)).toBe(1_000);
    expect(pollBackoffMs(1_000, 3)).toBe(8_000);
    expect(pollBackoffMs(5_000, 10)).toBe(60_000);
  });
});
