import { describe, expect, test } from "bun:test";
import { type ProbeRun, planRetention } from "../lib/probe_retention.ts";

function run(
  id: string,
  operations: Array<{ operation: string; status: number }>,
): ProbeRun {
  return { id, operations };
}

describe("probe retention", () => {
  test("keeps the newest n runs", () => {
    const runs = [
      run("2026-11-01T01", []),
      run("2026-11-01T02", []),
      run("2026-11-01T03", []),
    ];
    const plan = planRetention(runs, { keep: 2 });
    expect(plan.keep).toEqual(["2026-11-01T02", "2026-11-01T03"]);
    expect(plan.remove).toEqual(["2026-11-01T01"]);
  });

  test("keeps the newest success per operation even when it is older than keep", () => {
    const runs = [
      run("2026-11-01T01", [{ operation: "Pending", status: 200 }]),
      run("2026-11-01T02", [{ operation: "Pending", status: 500 }]),
      run("2026-11-01T03", [{ operation: "Pending", status: 500 }]),
    ];
    const plan = planRetention(runs, { keep: 1 });
    expect(plan.keep).toContain("2026-11-01T01");
    expect(plan.keep).toContain("2026-11-01T03");
    expect(plan.remove).toEqual(["2026-11-01T02"]);
  });

  test("a run that only ever failed is not made permanent by retention", () => {
    const runs = [
      run("2026-11-01T01", [{ operation: "getGrading", status: 500 }]),
      run("2026-11-01T02", [{ operation: "getGrading", status: 500 }]),
      run("2026-11-01T03", [{ operation: "getGrading", status: 200 }]),
    ];
    const plan = planRetention(runs, { keep: 1 });
    expect(plan.keep).toEqual(["2026-11-01T03"]);
    expect(plan.remove).toEqual(["2026-11-01T01", "2026-11-01T02"]);
  });

  test("keep 0 still preserves successes", () => {
    const runs = [
      run("2026-11-01T01", [{ operation: "Pending", status: 200 }]),
      run("2026-11-01T02", [{ operation: "Pending", status: 500 }]),
    ];
    const plan = planRetention(runs, { keep: 0 });
    expect(plan.keep).toEqual(["2026-11-01T01"]);
  });
});
