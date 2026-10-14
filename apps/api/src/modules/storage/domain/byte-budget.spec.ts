import { describe, expect, it } from 'vitest';

import { ByteBudget, ByteBudgetTimeoutError } from './byte-budget';

const MiB = 1024 * 1024;

/** A unit of work that finishes when told to, and says when it started. */
function gate() {
  let open!: () => void;
  const finished = new Promise<void>((resolve) => {
    open = resolve;
  });
  const started = { value: false };
  return {
    started,
    open,
    work: async () => {
      started.value = true;
      await finished;
      return 'done';
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('ByteBudget', () => {
  it('admits work up to its capacity at once and holds the rest', async () => {
    const budget = new ByteBudget(256 * MiB);
    const [a, b, c] = [gate(), gate(), gate()];
    const runs = [
      budget.run(120 * MiB, 10_000, a.work),
      budget.run(120 * MiB, 10_000, b.work),
      budget.run(120 * MiB, 10_000, c.work),
    ];
    await tick();
    expect([a.started.value, b.started.value, c.started.value]).toEqual([true, true, false]);
    expect(budget.usage()).toEqual({ inFlightBytes: 240 * MiB, active: 2, waiting: 1 });

    a.open();
    await runs[0];
    await tick();
    expect(c.started.value).toBe(true);
    b.open();
    c.open();
    await Promise.all(runs);
    expect(budget.usage()).toEqual({ inFlightBytes: 0, active: 0, waiting: 0 });
  });

  it('serves waiters in order: a small item does not overtake a large one ahead of it', async () => {
    const budget = new ByteBudget(200 * MiB);
    const running = gate();
    const large = gate();
    const small = gate();
    const first = budget.run(150 * MiB, 10_000, running.work);
    const second = budget.run(150 * MiB, 10_000, large.work);
    const third = budget.run(1 * MiB, 10_000, small.work);
    await tick();
    // 1 MiB would fit beside the running 150 MiB, but the large waiter is first.
    expect([large.started.value, small.started.value]).toEqual([false, false]);
    running.open();
    await first;
    await tick();
    expect([large.started.value, small.started.value]).toEqual([true, true]);
    large.open();
    small.open();
    await Promise.all([second, third]);
  });

  it('runs one item larger than the whole capacity when nothing else is in flight', async () => {
    const budget = new ByteBudget(64 * MiB);
    await expect(budget.run(128 * MiB, 1_000, () => Promise.resolve('alone'))).resolves.toBe(
      'alone',
    );
  });

  it('refuses a wait that outlasts its bound, without running the work', async () => {
    const budget = new ByteBudget(100 * MiB);
    const holder = gate();
    const held = budget.run(100 * MiB, 10_000, holder.work);
    let ran = false;
    await expect(
      budget.run(10 * MiB, 20, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(ByteBudgetTimeoutError);
    expect(ran).toBe(false);
    expect(budget.usage().waiting).toBe(0);
    holder.open();
    await held;
    expect(budget.usage()).toEqual({ inFlightBytes: 0, active: 0, waiting: 0 });
  });

  it('lets the next waiter in when the one ahead of it gives up', async () => {
    const budget = new ByteBudget(100 * MiB);
    const holder = gate();
    const held = budget.run(60 * MiB, 10_000, holder.work);
    const impatient = budget.run(60 * MiB, 20, () => Promise.resolve('never'));
    const patient = gate();
    const behind = budget.run(30 * MiB, 10_000, patient.work);
    await expect(impatient).rejects.toBeInstanceOf(ByteBudgetTimeoutError);
    await tick();
    // 30 MiB fits beside the 60 MiB holder once the 60 MiB waiter ahead of it has left.
    expect(patient.started.value).toBe(true);
    holder.open();
    patient.open();
    await Promise.all([held, behind]);
  });

  it('releases what it admitted when the work fails', async () => {
    const budget = new ByteBudget(100 * MiB);
    await expect(
      budget.run(80 * MiB, 1_000, () => Promise.reject(new Error('scanner unreachable'))),
    ).rejects.toThrow('scanner unreachable');
    expect(budget.usage()).toEqual({ inFlightBytes: 0, active: 0, waiting: 0 });
    await expect(budget.run(80 * MiB, 1_000, () => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('refuses a capacity that is not positive', () => {
    expect(() => new ByteBudget(0)).toThrow();
  });
});
