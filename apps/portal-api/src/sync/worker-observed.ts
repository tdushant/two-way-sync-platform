/** Recent portal-db writes are evidence a worker ran. This is not a process heartbeat. */
export const WORKER_OBSERVED_WINDOW_MS = 30_000;

export function workerWasObserved(input: {
  now: Date;
  recent: Array<Date | null>;
  leaseUntil: Date | null;
  windowMs?: number;
}): boolean {
  const windowMs = input.windowMs ?? WORKER_OBSERVED_WINDOW_MS;
  if (input.leaseUntil !== null && input.leaseUntil.getTime() > input.now.getTime()) {
    return true;
  }
  return input.recent.some((mark) => {
    if (mark === null) {
      return false;
    }
    const age = input.now.getTime() - mark.getTime();
    return age >= 0 && age <= windowMs;
  });
}
