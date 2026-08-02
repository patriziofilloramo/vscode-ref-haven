export interface SingleFlightReport {
  readonly durationMs: number;
  readonly sharedCallers: number;
}

interface InFlightOperation<T> {
  callers: number;
  result: Promise<T>;
}

/**
 * Coalesces concurrent operations by key: callers that arrive while an
 * operation for the same key is in flight share its settled result. The entry
 * is removed on settlement, so sequential callers always start a fresh
 * operation and results are never reused across time.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, InFlightOperation<T>>();

  public constructor(private readonly now: () => number = Date.now) {}

  /** `onSettled` reports timing and sharing for the call that started the operation. */
  public run(
    key: string,
    operation: () => Promise<T>,
    onSettled?: (report: SingleFlightReport) => void,
  ): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      existing.callers += 1;
      return existing.result;
    }
    const startedAt = this.now();
    const entry: InFlightOperation<T> = {
      callers: 1,
      result: Promise.resolve().then(operation),
    };
    entry.result = entry.result.finally(() => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      onSettled?.({ durationMs: this.now() - startedAt, sharedCallers: entry.callers });
    });
    this.inFlight.set(key, entry);
    return entry.result;
  }
}
