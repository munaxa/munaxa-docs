/**
 * How many bytes of content this process may hold for scanning at once — ADR-0026 §10, Phase A.
 *
 * Completing an upload reads the object back whole and sends it to the scanner (the ICAP adapter
 * holds it as one buffer), so every completion in flight costs memory in proportion to its size.
 * Phase A measured it: four ~120 MiB completions at once peaked at about 1.1 GB in an API limited
 * to 1.5 GB, and eight got the process killed by the kernel. The size ceiling bounds one upload;
 * nothing bounded how many ran together.
 *
 * This does. A completion asks for its size in bytes and waits, first come first served, until
 * the bytes already admitted plus its own fit the capacity. One item is always admitted when
 * nothing else is in flight, so a file larger than the capacity is slow, never stuck. A wait has a
 * bound: past it the caller is refused with {@link ByteBudgetTimeoutError} and nothing it was
 * waiting to do has happened — the upload is still there to complete again.
 *
 * Process-local on purpose. The memory it protects is this process's, and the Hetzner template
 * runs one API process; a deployment that runs several gets one budget each, which is still the
 * right bound for each.
 */
export class ByteBudget {
  private inFlight = 0;
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(readonly capacityBytes: number) {
    if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) {
      throw new Error('A byte budget needs a positive capacity.');
    }
  }

  /** Runs `work` once `weightBytes` are admitted, and releases them however it ends. */
  async run<T>(weightBytes: number, timeoutMs: number, work: () => Promise<T>): Promise<T> {
    await this.acquire(Math.max(0, weightBytes), timeoutMs);
    try {
      return await work();
    } finally {
      this.release(Math.max(0, weightBytes));
    }
  }

  /** What is admitted and what waits — for logs and tests, never for decisions elsewhere. */
  usage(): { readonly inFlightBytes: number; readonly active: number; readonly waiting: number } {
    return { inFlightBytes: this.inFlight, active: this.active, waiting: this.waiting.length };
  }

  private acquire(weight: number, timeoutMs: number): Promise<void> {
    // First come, first served: nobody overtakes a waiter, so a large file is not starved by a
    // stream of small ones that would each fit beside whatever is running.
    if (this.waiting.length === 0 && this.fits(weight)) {
      this.admit(weight);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        weight,
        grant: () => {
          clearTimeout(timer);
          this.admit(weight);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          // The head may have been the one holding the others back.
          this.drain();
          reject(new ByteBudgetTimeoutError(weight, timeoutMs));
        }
      }, timeoutMs);
      timer.unref?.();
      this.waiting.push(waiter);
    });
  }

  private release(weight: number): void {
    this.inFlight -= weight;
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const head = this.waiting[0];
      if (head === undefined || !this.fits(head.weight)) {
        return;
      }
      this.waiting.shift();
      head.grant();
    }
  }

  private fits(weight: number): boolean {
    return this.active === 0 || this.inFlight + weight <= this.capacityBytes;
  }

  private admit(weight: number): void {
    this.inFlight += weight;
    this.active += 1;
  }
}

interface Waiter {
  readonly weight: number;
  readonly grant: () => void;
}

/** A wait for capacity ran out. Nothing the caller was waiting to do has started. */
export class ByteBudgetTimeoutError extends Error {
  constructor(
    readonly weightBytes: number,
    readonly timeoutMs: number,
  ) {
    super(`Waited ${String(timeoutMs)} ms for ${String(weightBytes)} bytes of scan capacity.`);
    this.name = 'ByteBudgetTimeoutError';
  }
}
