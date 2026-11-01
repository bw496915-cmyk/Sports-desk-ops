/** Monotonic trace IDs + step timing (`Bun.randomUUIDv7`, `Bun.nanoseconds`). */

export interface TraceHandle {
  readonly id: string;
  step(name: string): void;
}

export async function withTrace<T>(
  name: string,
  fn: (trace: TraceHandle) => Promise<T>,
): Promise<T> {
  const id = Bun.randomUUIDv7();
  const t0 = Bun.nanoseconds();
  const steps: { step: string; ns: number }[] = [];
  const step = (stepName: string) => {
    steps.push({ step: stepName, ns: Bun.nanoseconds() - t0 });
  };
  step(`start:${name}`);
  try {
    return await fn({ id, step });
  } finally {
    step(`end:${name}`);
    if (Bun.env.DEBUG_TRACE === "1" || Bun.env.DEBUG_TRACE === "true") {
      console.error(id, Bun.inspect.table(steps, { colors: true }));
    }
  }
}
