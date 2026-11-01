import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertCaptureRecord,
  captureHash,
  readCaptureManifest,
} from "./recorder.ts";

const STORE_ROOT = join(import.meta.dir, "../../docs/evidence/captures");

describe("capture record hash round-trip", () => {
  test("assertCaptureRecord preserves full provenance for manifest verify", async () => {
    const rel = "2026-11-01/getDailyFiguresByCustomer.post.json";
    const text = await Bun.file(join(STORE_ROOT, rel)).text();
    const parsed = JSON.parse(text) as unknown;
    const record = assertCaptureRecord(parsed);
    expect(record.provenance.observation).toBe("webkit");
    expect(record.provenance.body).toBe("populated-shell");
    expect(record.provenance.cfRay).toBe("a5380531ccb34532-ATL");
    expect(record.provenance.state?.domVersion).toBe("1.0.280");

    const manifest = await readCaptureManifest(STORE_ROOT);
    expect(manifest).not.toBeNull();
    if (manifest === null) return;
    const entry = manifest.captures.find((c) => c.file === rel);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(captureHash(record)).toBe(entry.captureHash);
  });
});
