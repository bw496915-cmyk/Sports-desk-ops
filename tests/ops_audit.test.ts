import { describe, expect, test } from "bun:test";
import {
  type ArchiveProvenance,
  type Releases,
  auditArchives,
  auditReleases,
  compareReleaseTags,
  parseProvenance,
  parseReleases,
} from "../lib/ops_audit.ts";

const REGISTRY: Releases = {
  version: 1,
  current: "docs-v2026.11.01",
  tags: {
    "docs-v2026.11.01": { status: "current", deployable: true },
    "docs-v2026.10.31": {
      status: "superseded",
      deployable: false,
      supersededBy: "docs-v2026.11.01",
      reason: "cites a file that no longer exists",
    },
  },
};

const TAGS = ["docs-v2026.10.31", "docs-v2026.11.01"];

describe("release registry", () => {
  test("parses and rejects malformed registries", () => {
    expect(parseReleases(REGISTRY).current).toBe("docs-v2026.11.01");
    expect(() => parseReleases({ version: 2 })).toThrow("version");
    expect(() => parseReleases({ version: 1 })).toThrow("current");
    expect(() => parseReleases({ version: 1, current: "x" })).toThrow("tags");
    expect(() =>
      parseReleases({
        version: 1,
        current: "x",
        tags: { x: { status: "maybe", deployable: true } },
      }),
    ).toThrow("status");
    expect(() =>
      parseReleases({
        version: 1,
        current: "x",
        tags: { x: { status: "current" } },
      }),
    ).toThrow("deployable");
  });

  test("accepts a registry that matches the tags", () => {
    expect(auditReleases(TAGS, REGISTRY)).toEqual([]);
  });

  test("requires an entry per tag and a tag per entry", () => {
    expect(auditReleases([...TAGS, "docs-v2026.12.01"], REGISTRY)).toContain(
      "docs-v2026.12.01 has no registry entry",
    );
    const stale = {
      ...REGISTRY,
      tags: {
        ...REGISTRY.tags,
        "docs-v2026.09.30": REGISTRY.tags["docs-v2026.10.31"]!,
      },
    };
    expect(
      auditReleases(TAGS, stale).some((error) => error.includes("no such tag")),
    ).toBe(true);
  });

  test("rejects a second current, a non-deployable current, and a deployable superseded tag", () => {
    const twoCurrent: Releases = {
      ...REGISTRY,
      tags: {
        ...REGISTRY.tags,
        "docs-v2026.10.31": { status: "current", deployable: true },
      },
    };
    expect(auditReleases(TAGS, twoCurrent).length).toBeGreaterThan(0);

    const notDeployable: Releases = {
      ...REGISTRY,
      tags: {
        ...REGISTRY.tags,
        "docs-v2026.11.01": { status: "current", deployable: false },
      },
    };
    expect(auditReleases(TAGS, notDeployable)).toContain(
      "docs-v2026.11.01 is current but not deployable",
    );

    const deployableOld: Releases = {
      ...REGISTRY,
      tags: {
        ...REGISTRY.tags,
        "docs-v2026.10.31": {
          ...REGISTRY.tags["docs-v2026.10.31"]!,
          deployable: true,
        },
      },
    };
    expect(auditReleases(TAGS, deployableOld)).toContain(
      "docs-v2026.10.31 is superseded but still deployable",
    );
  });

  test("requires a replacement and a reason on superseded tags", () => {
    const bare: Releases = {
      ...REGISTRY,
      tags: {
        ...REGISTRY.tags,
        "docs-v2026.10.31": { status: "superseded", deployable: false },
      },
    };
    const errors = auditReleases(TAGS, bare);
    expect(errors).toContain(
      "docs-v2026.10.31 is superseded but names no replacement",
    );
    expect(errors).toContain(
      "docs-v2026.10.31 is superseded but records no reason",
    );

    const dangling: Releases = {
      ...REGISTRY,
      tags: {
        ...REGISTRY.tags,
        "docs-v2026.10.31": {
          ...REGISTRY.tags["docs-v2026.10.31"]!,
          supersededBy: "docs-v2026.9.1",
        },
      },
    };
    expect(
      auditReleases(TAGS, dangling).some((error) =>
        error.includes("which is not registered"),
      ),
    ).toBe(true);
  });

  test("current must be the newest tag", () => {
    const older: Releases = {
      ...REGISTRY,
      current: "docs-v2026.10.31",
      tags: {
        "docs-v2026.11.01": {
          status: "superseded",
          deployable: false,
          supersededBy: "docs-v2026.10.31",
          reason: "x",
        },
        "docs-v2026.10.31": { status: "current", deployable: true },
      },
    };
    expect(auditReleases(TAGS, older)).toContain(
      "registry.current is docs-v2026.10.31; the newest tag is docs-v2026.11.01",
    );
  });
});

describe("archive provenance", () => {
  const archive = { file: "tool.zip", sha256: "a".repeat(64), bytes: 10 };
  const sidecar: ArchiveProvenance = {
    version: 1,
    file: "tool.zip",
    sha256: "a".repeat(64),
    bytes: 10,
    origin: "vendor upload 2026-10-20",
    license: "Apache-2.0",
    recordedAt: "2026-10-31",
  };

  test("parses and rejects malformed sidecars", () => {
    expect(parseProvenance(sidecar).license).toBe("Apache-2.0");
    expect(() => parseProvenance({ version: 2 })).toThrow("version");
    expect(() => parseProvenance({ version: 1, file: "x" })).toThrow("bytes");
    expect(() =>
      parseProvenance({
        version: 1,
        file: "x",
        bytes: 0,
        origin: "o",
        license: "l",
        recordedAt: "d",
      }),
    ).toThrow("sha256");
    expect(() => parseProvenance({ ...sidecar, bytes: -1 })).toThrow("bytes");
  });

  test("accepts a matching sidecar", () => {
    expect(auditArchives([archive], new Map([["tool.zip", sidecar]]))).toEqual(
      [],
    );
  });

  test("requires a sidecar and a matching checksum", () => {
    expect(auditArchives([archive], new Map())).toEqual([
      "tool.zip: no provenance/tool.zip.json",
    ]);
    expect(
      auditArchives(
        [archive],
        new Map([["tool.zip", { ...sidecar, sha256: "b".repeat(64) }]]),
      ),
    ).toContain("tool.zip: sidecar sha256 does not match");
    expect(
      auditArchives(
        [archive],
        new Map([["tool.zip", { ...sidecar, bytes: 11 }]]),
      ),
    ).toContain("tool.zip: sidecar bytes 11 != 10");
  });

  test("rejects placeholder provenance", () => {
    for (const value of ["unknown", "TBD", "n/a", "none", " "]) {
      const errors = auditArchives(
        [archive],
        new Map([["tool.zip", { ...sidecar, origin: value }]]),
      );
      expect(errors).toContain("tool.zip: origin is not provenance");
      expect(
        auditArchives(
          [archive],
          new Map([["tool.zip", { ...sidecar, license: value }]]),
        ),
      ).toContain("tool.zip: license is not provenance");
    }
  });
});

describe("release tag ordering", () => {
  test("orders by the date, not by the string", () => {
    expect(compareReleaseTags("docs-v2026.9.1", "docs-v2026.10.31")).toBe(-1);
    expect(compareReleaseTags("docs-v2026.11.01", "docs-v2026.10.31")).toBe(1);
    expect(compareReleaseTags("docs-v2026.11.1", "docs-v2026.11.01")).toBe(0);
    const sorted = [
      "docs-v2026.11.01",
      "docs-v2026.9.1",
      "docs-v2026.10.31",
    ].sort(compareReleaseTags);
    expect(sorted).toEqual([
      "docs-v2026.9.1",
      "docs-v2026.10.31",
      "docs-v2026.11.01",
    ]);
  });
});
