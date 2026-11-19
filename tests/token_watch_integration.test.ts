/**
 * @file tests/token_watch_integration.test.ts
 * @description End-to-end wiring for the token-watch v1.4.4 integration: hook-driven theme sync,
 * avatar hydration and preview backpressure share one lifecycle and one SQLite connection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProfileId,
  assertRgb24,
  computeSnapshotFingerprint,
  type RegistryColorRow,
} from "../lib/token_automation.ts";
import {
  startTokenWatchIntegration,
  type TokenWatchIntegration,
} from "../lib/token_watch_integration.ts";
import type { PreviewSocket } from "../lib/token_watch_preview.ts";

/** 1x1 opaque PNG; generated once here so no binary fixture is committed. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lS8AAAAASUVORK5CYII=",
  "base64",
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface PipelineFixture {
  readonly root: string;
  readonly avatarsDir: string;
  readonly dbPath: string;
  readonly targets: {
    readonly envPath: string;
    readonly envExamplePath: string;
    readonly themeGenPath: string;
  };
}

function makeFixture(): PipelineFixture {
  const root = mkdtempSync(join(tmpdir(), "token-watch-integration-"));
  dirs.push(root);
  const avatarsDir = join(root, "avatars");
  mkdirSync(avatarsDir);
  for (const file of [
    "desk-enam-01.png",
    "desk-enam-01.test.png",
    "desk-mut-foo.png",
    "desk-other.png",
    "xdesk-enam-01.png",
  ]) {
    writeFileSync(join(avatarsDir, file), TINY_PNG);
  }
  return {
    root,
    avatarsDir,
    dbPath: join(root, "themes.sqlite"),
    targets: {
      envPath: join(root, ".env"),
      envExamplePath: join(root, ".env.example"),
      themeGenPath: join(root, "index.theme.gen.ts"),
    },
  };
}

function insertTheme(
  pipeline: TokenWatchIntegration,
  profileId: string,
  color: string,
  label: string,
): void {
  pipeline.db.run(
    `INSERT INTO profile_themes
       (profile_id, color_int, color_css, color_label, updated_at_ms)
     VALUES (?1, bun_color_int(?2), bun_color_css(?2), ?3, ?4)`,
    [profileId, color, label, 1],
  );
}

function snapshotRows(pipeline: TokenWatchIntegration): RegistryColorRow[] {
  const rows = pipeline.db
    .query(
      `SELECT profile_id, color_int, color_css, color_hex, color_label
       FROM profile_themes ORDER BY profile_id ASC`,
    )
    .all() as Array<{
    profile_id: string;
    color_int: number;
    color_css: string;
    color_hex: string;
    color_label: string;
  }>;
  return rows.map((row) => ({
    profile_id: assertProfileId(row.profile_id),
    color_int: assertRgb24(Number(row.color_int)),
    color_css: row.color_css,
    color_hex: row.color_hex,
    color_label: row.color_label,
  }));
}

interface FakeSocket extends PreviewSocket {
  readonly sent: string[];
  readonly closes: Array<{
    code?: number | undefined;
    reason?: string | undefined;
  }>;
  paused: boolean;
}

function fakeSocket(sendResult = 1): FakeSocket {
  const sent: string[] = [];
  const closes: Array<{
    code?: number | undefined;
    reason?: string | undefined;
  }> = [];
  let nextResult = sendResult;
  return {
    sent,
    closes,
    paused: false,
    send(data: string | Uint8Array): number {
      sent.push(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      );
      const result = nextResult;
      nextResult = 1; // only the first frame is backpressured
      return result;
    },
    pause(): void {
      this.paused = true;
    },
    resume(): void {
      this.paused = false;
    },
    close(code?: number, reason?: string): void {
      closes.push({ code, reason });
    },
  };
}

describe("token-watch integration wiring", () => {
  test("hook-driven sync writes the theme artifacts from a UDF insert", async () => {
    const fixture = makeFixture();
    const pipeline = startTokenWatchIntegration({
      dbPath: fixture.dbPath,
      avatarsDir: fixture.avatarsDir,
      targets: fixture.targets,
    });
    try {
      insertTheme(pipeline, "desk-01", "#f00", "red");
      await pipeline.sync.idle();

      expect(pipeline.sync.syncs).toBeGreaterThanOrEqual(1);
      const env = readFileSync(fixture.targets.envPath, "utf8");
      const envExample = readFileSync(fixture.targets.envExamplePath, "utf8");
      const themeGen = readFileSync(fixture.targets.themeGenPath, "utf8");
      const fingerprint = computeSnapshotFingerprint(snapshotRows(pipeline));

      expect(env).toContain("profile_id=desk-01");
      expect(env).toContain("PROFILE_DESK_01_COLOR_INT=16711680");
      expect(env).toContain(`sha256: ${fingerprint}`);
      expect(envExample).toContain('PROFILE_DESK_01_COLOR_LABEL="<label>"');
      expect(themeGen).toContain(
        `THEME_SNAPSHOT_SHA256 = ${JSON.stringify(fingerprint)}`,
      );
      expect(themeGen).toContain('"desk-01"');
    } finally {
      await pipeline.close();
    }
  });

  test("a burst of writes coalesces instead of overlapping syncs", async () => {
    const fixture = makeFixture();
    const pipeline = startTokenWatchIntegration({
      dbPath: fixture.dbPath,
      avatarsDir: fixture.avatarsDir,
      targets: fixture.targets,
    });
    try {
      insertTheme(pipeline, "desk-01", "#f00", "red");
      await pipeline.sync.idle();
      const syncsBeforeBurst = pipeline.sync.syncs;

      for (let index = 2; index <= 6; index += 1) {
        insertTheme(
          pipeline,
          `desk-0${index}`,
          "dodgerblue",
          `accent-${index}`,
        );
      }
      await pipeline.sync.idle();
      const burstSyncs = pipeline.sync.syncs - syncsBeforeBurst;

      expect(burstSyncs).toBeGreaterThanOrEqual(1);
      expect(burstSyncs).toBeLessThan(5);
      expect(readFileSync(fixture.targets.envPath, "utf8")).toContain(
        "profile_id=desk-06",
      );
      expect(snapshotRows(pipeline)).toHaveLength(6);
    } finally {
      await pipeline.close();
    }
  });

  test("avatar hydration filters test renders and validates the basename", async () => {
    const fixture = makeFixture();
    const pipeline = startTokenWatchIntegration({
      dbPath: fixture.dbPath,
      avatarsDir: fixture.avatarsDir,
      targets: fixture.targets,
    });
    try {
      expect(await pipeline.listAvatars()).toEqual([
        "desk-enam-01.png",
        "desk-mut-foo.png",
      ]);

      const base64 = await pipeline.encodeAvatar("desk-enam-01.png", 2, 2);
      expect(base64.startsWith("iVBOR")).toBe(true);

      await expect(
        pipeline.encodeAvatar("desk-enam-01.test.png", 2, 2),
      ).rejects.toThrow("ERR_TOKEN_WATCH_AVATAR");
      await expect(
        pipeline.encodeAvatar("../desk-enam-01.png", 2, 2),
      ).rejects.toThrow("ERR_TOKEN_WATCH_AVATAR");
    } finally {
      await pipeline.close();
    }
  });

  test("preview backpressure and close() teardown are wired to the hub", async () => {
    const fixture = makeFixture();
    const pipeline = startTokenWatchIntegration({
      dbPath: fixture.dbPath,
      avatarsDir: fixture.avatarsDir,
      targets: fixture.targets,
    });
    const backpressured = fakeSocket(-1);
    const healthy = fakeSocket(1);

    pipeline.preview.websocket.open(backpressured);
    pipeline.preview.websocket.open(healthy);
    const report = pipeline.preview.broadcast("frame-1");

    expect(report).toEqual({ delivered: 1, paused: 1, dropped: 0 });
    expect(backpressured.paused).toBe(true);
    expect(backpressured.sent).toEqual(["frame-1"]);
    expect(healthy.sent).toEqual(["frame-1"]);

    pipeline.preview.websocket.drain(backpressured);
    expect(backpressured.paused).toBe(false);
    expect(pipeline.preview.broadcast("frame-2").paused).toBe(0);

    await pipeline.close();
    expect(pipeline.preview.clients).toBe(0);
    expect(backpressured.closes[0]?.code).toBe(1011);
    expect(healthy.closes[0]?.code).toBe(1011);
    // Idempotent: a second close is a no-op rather than a second DB close.
    await pipeline.close();
    expect(() => pipeline.db.query("SELECT 1").get()).toThrow(/closed/i);
  });

  test("close() tears down before surfacing a rejected sync", async () => {
    const fixture = makeFixture();
    // A directory at envPath makes atomicWrite's rename fail with EISDIR, so the sync rejects.
    mkdirSync(fixture.targets.envPath);
    const pipeline = startTokenWatchIntegration({
      dbPath: fixture.dbPath,
      avatarsDir: fixture.avatarsDir,
      targets: fixture.targets,
    });
    insertTheme(pipeline, "desk-01", "#f00", "red");
    await expect(pipeline.sync.idle()).rejects.toThrow();

    const client = fakeSocket(1);
    pipeline.preview.websocket.open(client);
    const [first, second] = await Promise.allSettled([
      pipeline.close(),
      pipeline.close(),
    ]);

    // The sync failure is surfaced, but only after the cleanup has run.
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    expect(pipeline.preview.clients).toBe(0);
    expect(client.closes[0]?.code).toBe(1011);
    expect(() => pipeline.db.query("SELECT 1").get()).toThrow(/closed/i);
  });
});
