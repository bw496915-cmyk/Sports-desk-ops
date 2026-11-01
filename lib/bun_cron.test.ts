import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import {
  isBunOsCronInvocation,
  osCronWorkerPath,
  parseCronSchedule,
} from "./bun_cron.ts";

describe("bun_cron", () => {
  test("isBunOsCronInvocation detects OS cron argv", () => {
    expect(isBunOsCronInvocation(["bun", "run", "worker.ts"])).toBe(false);
    expect(
      isBunOsCronInvocation([
        "bun",
        "run",
        "--cron-title=weekly-report",
        "--cron-period=0 6 * * *",
        "/abs/worker.ts",
      ]),
    ).toBe(true);
  });

  test("osCronWorkerPath resolves import.meta.url", () => {
    expect(osCronWorkerPath(import.meta.url)).toBe(
      fileURLToPath(import.meta.url),
    );
  });

  test("parseCronSchedule accepts @daily", () => {
    const next = parseCronSchedule("@daily");
    expect(next instanceof Date).toBe(true);
  });
});
