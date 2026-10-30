'use strict';

// Fixed-window rate limiter kept in memory. Good enough for one app instance;
// a multi-instance deployment should move this to a shared store.
class RateLimiter {
  constructor({ limit, windowMs, now = Date.now, maxKeys = 50000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  // Records one attempt for key. Returns { allowed, retryAfterSeconds }.
  hit(key) {
    const time = this.now();
    if (this.buckets.size >= this.maxKeys) this.prune(time);

    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= time) {
      bucket = { count: 0, resetAt: time + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - time) / 1000)) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // Clears a key, e.g. after a successful login.
  reset(key) {
    this.buckets.delete(key);
  }

  prune(time = this.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= time) this.buckets.delete(key);
    }
  }
}

module.exports = { RateLimiter };
