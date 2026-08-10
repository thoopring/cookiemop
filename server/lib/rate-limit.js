// Fixed-window rate limiter, in memory.
//
// Serverless instances are not shared, so this bounds abuse per warm
// instance rather than globally. That is enough here: a lookup needs a valid
// order number as well as the matching email, so there is little to gain by
// hammering the endpoint. Anything stronger would mean adding a datastore,
// which this design deliberately avoids.

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

const hits = new Map(); // ip -> { count, resetAt }

export function checkRateLimit(ip, now = Date.now()) {
  const key = ip || 'unknown';
  const entry = hits.get(key);

  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: MAX_REQUESTS - 1, retryAfterSeconds: 0 };
  }

  if (entry.count >= MAX_REQUESTS) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  entry.count += 1;
  return { allowed: true, remaining: MAX_REQUESTS - entry.count, retryAfterSeconds: 0 };
}

/** Drop expired buckets so a long-lived instance does not grow unbounded. */
export function pruneRateLimit(now = Date.now()) {
  for (const [key, entry] of hits) {
    if (now >= entry.resetAt) hits.delete(key);
  }
}

/** Test seam. */
export function resetRateLimit() {
  hits.clear();
}

export const RATE_LIMIT = { WINDOW_MS, MAX_REQUESTS };
