/** Own response handlers and their detached output-capture/finally work separately from HTTP. */
export class ResponseProducers {
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly failures = new Set<unknown>();
  private settlement?: Promise<void>;

  get signal(): AbortSignal { return this.abort.signal; }
  get settled(): boolean { return this.signal.aborted && this.pending.size === 0; }

  /** Register before starting work, including handlers still reading their request body. */
  run<T>(work: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const result = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return work();
    });
    const observed = result.then(
      () => { this.pending.delete(observed); },
      error => {
        this.pending.delete(observed);
        if (error !== this.signal.reason) this.failures.add(error);
      },
    );
    this.pending.add(observed);
    return result;
  }

  /** Seal admission before closing HTTP or taking browser-worker cleanup snapshots. */
  stop(): void {
    this.abort.abort(new DOMException("Response owner is stopping", "AbortError"));
  }

  /** A timeout is sticky: late completion cannot turn uncertain owner cleanup into success. */
  settle(timeoutMs: number): Promise<void> {
    if (this.settlement) return this.settlement;
    if (!this.signal.aborted) throw new Error("Stop response admission before joining producers");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Response settlement requires a finite nonnegative deadline");
    this.settlement = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!this.pending.size) {
          if (this.failures.size) throw new AggregateError([...this.failures], "Response producer failed during owned execution");
          return;
        }
        if (timeoutMs === 0) throw new Error("Response producers remain unsettled at the caller's stopping boundary");
        await Promise.race([
          Promise.all([...this.pending]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Response producers did not settle before the cleanup deadline")), timeoutMs);
          }),
        ]);
        if (this.failures.size) throw new AggregateError([...this.failures], "Response producer failed during owned execution");
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.settlement;
  }
}
