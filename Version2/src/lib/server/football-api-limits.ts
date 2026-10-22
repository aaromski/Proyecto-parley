export const FOOTBALL_MAX_DAYS_PER_REQUEST = 10;
export const FOOTBALL_MIN_REQUEST_INTERVAL_MS = 6_500;

export function getRetryDelaySeconds(retryAfter: string | null, resetSeconds: string | null, now = Date.now()): number {
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(1, Math.ceil((retryAt - now) / 1000));
  }

  const reset = Number(resetSeconds);
  return Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : 60;
}

export function splitUtcDateRange(from: Date, to: Date, maxDays = FOOTBALL_MAX_DAYS_PER_REQUEST) {
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new RangeError("maxDays must be a positive integer");

  const dayMs = 24 * 60 * 60 * 1000;
  const lastDay = Date.parse(`${to.toISOString().slice(0, 10)}T00:00:00.000Z`);
  let firstDay = Date.parse(`${from.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const windows: Array<{ from: string; to: string }> = [];

  while (firstDay <= lastDay) {
    const windowEnd = Math.min(firstDay + (maxDays - 1) * dayMs, lastDay);
    windows.push({
      from: new Date(firstDay).toISOString().slice(0, 10),
      to: new Date(windowEnd).toISOString().slice(0, 10),
    });
    firstDay = windowEnd + dayMs;
  }

  return windows;
}

export function createRequestPacer(
  intervalMs: number,
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): (() => Promise<void>) & { defer: (milliseconds: number) => void } {
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let blockedUntil = 0;

  const pace = async () => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      while (true) {
        const currentTime = now();
        const delay = Math.max(0, nextRequestAt - currentTime, blockedUntil - currentTime);
        if (delay === 0) break;
        await sleep(delay);
      }
      nextRequestAt = now() + intervalMs;
    } finally {
      release();
    }
  };

  return Object.assign(pace, {
    defer(milliseconds: number) {
      if (Number.isFinite(milliseconds) && milliseconds > 0) {
        blockedUntil = Math.max(blockedUntil, now() + milliseconds);
      }
    },
  });
}