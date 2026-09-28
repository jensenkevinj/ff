// Tiny in-memory TTL cache. Every open tab polls /api/matchups; this makes them share one upstream
// call per league instead of each tab triggering its own.
//
// It stores the *promise*, not the resolved value, so concurrent callers that arrive while a load is
// still in flight all await the same request instead of starting duplicates.
export class TtlCache<T> {
  // `#` fields are real JavaScript private fields (enforced at runtime), unlike TS's `private`,
  // which only exists at compile time.
  readonly #entries = new Map<string, { expires: number; value: Promise<T> }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.#entries.get(key);
    if (hit && hit.expires > this.#now()) return hit.value;

    const value = load();
    this.#entries.set(key, { expires: this.#now() + this.#ttlMs, value });
    // Don't cache failures: drop the entry so the next call retries. The caller still sees the
    // rejection through `value`; this handler only cleans up.
    void value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    return value;
  }
}
