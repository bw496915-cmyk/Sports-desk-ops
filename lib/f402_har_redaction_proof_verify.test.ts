import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { verifyHarRedactionProofFiles } from "./f402_har_redaction_proof_verify.ts";

const FIX = join(import.meta.dir, "../tests/fixtures");

describe("HAR redaction proof verifier (synthetic)", () => {
  test("green fixture: verify returns ok (gate exit 0 path)", async () => {
    const result = await verifyHarRedactionProofFiles({
      proofPath: join(FIX, "f402-har-synthetic-pass.redaction-proof.json"),
      harPath: join(FIX, "f402-har-synthetic-pass.redacted.har.json"),
    });
    expect(result).toEqual({ kind: "ok" });
  });

  test("red fixture: sweep failure (gate exit 1 path)", async () => {
    const result = await verifyHarRedactionProofFiles({
      proofPath: join(FIX, "f402-har-synthetic-fail.redaction-proof.json"),
      harPath: join(FIX, "f402-har-synthetic-fail.redacted.har.json"),
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(["F402_HAR_SWEEP_FAILED", "F402_HAR_PROOF_HASH_MISMATCH"]).toContain(
        result.signal,
      );
    }
  });

  test("hash mismatch when HAR edited after proof", async () => {
    const result = await verifyHarRedactionProofFiles({
      proofPath: join(FIX, "f402-har-synthetic-pass.redaction-proof.json"),
      harPath: join(FIX, "f402-har-synthetic-fail.redacted.har.json"),
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.signal).toBe("F402_HAR_PROOF_HASH_MISMATCH");
    }
  });
});
