interface CacheEntry<T> {
  readonly promise: Promise<T>;
  weight: number;
}

/** LRU cache bounded by both entry count and resolved-value weight. */
export class BoundedPromiseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private totalWeight = 0;

  public constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
    private readonly weigh: (value: T) => number,
  ) {
    if (maxEntries < 1 || maxWeight < 1) throw new Error("Cache limits must be positive.");
  }

  public getOrCreate(key: string, factory: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }

    const promise = Promise.resolve()
      .then(factory)
      .then(
        (value) => {
          const current = this.entries.get(key);
          if (current?.promise === promise) {
            current.weight = Math.max(0, this.weigh(value));
            this.totalWeight += current.weight;
            this.trim();
          }
          return value;
        },
        (error: unknown) => {
          const current = this.entries.get(key);
          if (current?.promise === promise) this.deleteEntry(key, current);
          throw error;
        },
      );
    const entry: CacheEntry<T> = { promise, weight: 0 };
    this.entries.set(key, entry);
    this.trim();
    return promise;
  }

  public clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = this.entries.entries().next();
      if (oldest.done) return;
      this.deleteEntry(oldest.value[0], oldest.value[1]);
    }
  }

  private deleteEntry(key: string, entry: CacheEntry<T>): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}
