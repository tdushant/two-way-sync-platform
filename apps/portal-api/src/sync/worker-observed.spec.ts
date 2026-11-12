import { describe, expect, it } from '@jest/globals';
import { workerWasObserved } from './worker-observed';

const now = new Date('2026-11-12T12:00:00.000Z');

describe('worker observation', () => {
  it('accepts a checkpoint or outbox touch inside the window', () => {
    expect(
      workerWasObserved({
        now,
        recent: [new Date('2026-11-12T11:59:40.000Z')],
        leaseUntil: null,
      }),
    ).toBe(true);
  });

  it('rejects a stale touch and a lease that has already expired', () => {
    expect(
      workerWasObserved({
        now,
        recent: [new Date('2026-11-12T11:59:00.000Z'), null],
        leaseUntil: new Date('2026-11-12T11:59:59.000Z'),
      }),
    ).toBe(false);
  });

  it('treats a lease that is still open as a live worker', () => {
    expect(
      workerWasObserved({
        now,
        recent: [],
        leaseUntil: new Date('2026-11-12T12:00:30.000Z'),
      }),
    ).toBe(true);
  });
});
