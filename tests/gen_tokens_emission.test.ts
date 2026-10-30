import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildManifestFromDisk,
  sha256File,
  verifyManifestAgainstDisk,
} from "../lib/gen_tokens/emission_manifest.ts";
import {
  GEN_TOKEN_EMISSION_PATHS,
  GEN_TOKEN_EMISSION_TARGETS,
} from "../lib/gen_tokens/emission_targets.ts";
import { DASHBOARD_TEMPLATES } from "../lib/gen_tokens/dashboard_templates.ts";

describe("gen_tokens emission registry", () => {
  it("dashboard templates match registry html paths", () => {
    const registryHtml = GEN_TOKEN_EMISSION_TARGETS.filter((t) =>
      t.repoPath.endsWith(".html"),
    ).map((t) => t.repoPath);
    const templatePaths = DASHBOARD_TEMPLATES.map((t) => t.repoPath);
    expect(templatePaths.sort()).toEqual(registryHtml.sort());
  });

  it("registry paths are unique", () => {
    expect(new Set(GEN_TOKEN_EMISSION_PATHS).size).toBe(
      GEN_TOKEN_EMISSION_PATHS.length,
    );
  });
});

describe("emission manifest", () => {
  it("sha256File detects content change", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-tokens-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "one\n", "utf-8");
    const h1 = sha256File(file);
    fs.writeFileSync(file, "two\n", "utf-8");
    expect(sha256File(file)).not.toBe(h1);
    fs.rmSync(dir, { recursive: true });
  });

  it("buildManifestFromDisk hashes current bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-tokens-"));
    const rel = "sub/x.txt";
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "payload\n", "utf-8");
    const manifest = buildManifestFromDisk(dir, [rel], "run-a");
    expect(manifest.gateRunId).toBe("run-a");
    expect(manifest.emitted[0]?.sha256).toBe(sha256File(abs));
    fs.rmSync(dir, { recursive: true });
  });

  it("verifyManifestAgainstDisk rejects gateRunId mismatch", () => {
    const err = verifyManifestAgainstDisk(
      "/tmp",
      { gateRunId: "expected", emitted: [] },
      "other",
    );
    expect(err).toMatch(/gateRunId mismatch/);
  });
});
