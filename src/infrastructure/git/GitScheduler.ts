interface QueueEntry {
  readonly key: string;
  readonly onAbort?: () => void;
  readonly reject: (error: Error) => void;
  readonly resolve: (release: () => void) => void;
  readonly signal?: AbortSignal;
}

export class GitScheduler {
  private activeGlobal = 0;
  private readonly activePerKey = new Map<string, number>();
  private readonly queue: QueueEntry[] = [];

  public constructor(
    private readonly globalLimit = 4,
    private readonly perKeyLimit = 2,
  ) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1) {
      throw new Error("Global Git concurrency limit must be a positive integer.");
    }
    if (!Number.isInteger(perKeyLimit) || perKeyLimit < 1 || perKeyLimit > globalLimit) {
      throw new Error("Per-repository Git concurrency limit is invalid.");
    }
  }

  public async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(key, signal);
    try {
      if (signal?.aborted) throw createAbortError();
      return await task();
    } finally {
      release();
    }
  }

  private acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(createAbortError());

    return new Promise((resolve, reject) => {
      const onAbort = (): void => this.cancelQueued(entry);
      const entry: QueueEntry = {
        key,
        ...(signal ? { onAbort } : {}),
        reject,
        resolve,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(entry);
      this.drain();
    });
  }

  private cancelQueued(entry: QueueEntry): void {
    const index = this.queue.indexOf(entry);
    if (index === -1) return;
    this.queue.splice(index, 1);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    entry.reject(createAbortError());
  }

  private drain(): void {
    while (this.activeGlobal < this.globalLimit) {
      const index = this.queue.findIndex(
        ({ key }) => (this.activePerKey.get(key) ?? 0) < this.perKeyLimit,
      );
      if (index === -1) return;
      const [entry] = this.queue.splice(index, 1);
      if (!entry) return;
      if (entry.signal?.aborted) {
        entry.reject(createAbortError());
        continue;
      }
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener("abort", entry.onAbort);
      }

      this.activeGlobal += 1;
      this.activePerKey.set(entry.key, (this.activePerKey.get(entry.key) ?? 0) + 1);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.activeGlobal -= 1;
        const remaining = (this.activePerKey.get(entry.key) ?? 1) - 1;
        if (remaining === 0) this.activePerKey.delete(entry.key);
        else this.activePerKey.set(entry.key, remaining);
        this.drain();
      });
    }
  }
}

export function createAbortError(): Error {
  const error = new Error("The Git operation was cancelled.");
  error.name = "AbortError";
  return error;
}
