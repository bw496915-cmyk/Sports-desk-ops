import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomatedDualTokenStore } from "../lib/token_automation.ts";
import type { SyncState, SyncTargets } from "../lib/token_watch_daemon.ts";
import {
  attachThemeSyncHooks,
  registerColorUdfs,
  type ThemeSyncController,
  type ThemeSyncOptions,
} from "../lib/token_watch_theme_store.ts";

const stores: AutomatedDualTokenStore[] = [];
const controllers: ThemeSyncController[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeStore(): AutomatedDualTokenStore {
  const store = new AutomatedDualTokenStore(":memory:");
  stores.push(store);
  return store;
}

function makeTargets(): SyncTargets {
  const dir = mkdtempSync(join(tmpdir(), "token-watch-theme-store-"));
  dirs.push(dir);
  return {
    envPath: join(dir, ".env"),
    envExamplePath: join(dir, ".env.example"),
    themeGenPath: join(dir, "index.theme.gen.ts"),
  };
}

function freshState(): SyncState {
  return { lastDataVersion: -1, lastFingerprint: "" };
}

/** A store whose connection carries the colour UDFs, like the daemon wiring. */
function freshDb(): { store: AutomatedDualTokenStore; db: Database } {
  const store = makeStore();
  const db = store.database;
  registerColorUdfs(db);
  return { store, db };
}

function attach(
  db: Database,
  state: SyncState,
  targets: SyncTargets,
  options?: ThemeSyncOptions,
): ThemeSyncController {
  const controller = attachThemeSyncHooks(db, state, targets, options);
  controllers.push(controller);
  return controller;
}

const INSERT_THEME = `INSERT INTO profile_themes
  (profile_id, color_int, color_css, color_label, updated_at_ms)
  VALUES (?1, bun_color_int('#f00'), bun_color_css('#f00'), ?2, 1)`;

const INSERT_BAD_COLOR = `INSERT INTO profile_themes
  (profile_id, color_int, color_css, color_label, updated_at_ms)
  VALUES (?1, bun_color_int(NULL), 'red', 'red', 1)`;

function insertTheme(db: Database, profileId: string, label = "red"): void {
  db.query(INSERT_THEME).run(profileId, label);
}

function countRows(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM profile_themes")
    .get() as { count: number | bigint };
  return Number(row.count);
}

describe("registerColorUdfs", () => {
  test("INSERT stores Bun.color's canonical integer and CSS", () => {
    const { db } = freshDb();
    insertTheme(db, "p1");

    const row = db
      .query(
        `SELECT color_int, color_css, color_hex
         FROM profile_themes WHERE profile_id = 'p1'`,
      )
      .get() as {
      color_int: number | bigint;
      color_css: string;
      color_hex: string;
    };
    expect(Number(row.color_int)).toBe(0xff0000);
    // Bun.color canonicalizes #f00 to the named colour.
    expect(row.color_css).toBe("red");
    expect(row.color_hex).toBe("#ff0000");

    // Every accepted spelling yields the same canonical pair.
    for (const input of [
      "#f00",
      "#ff0000",
      "rgb(255, 0, 0)",
      "hsl(0, 100%, 50%)",
      "red",
    ]) {
      const parsed = db
        .query(
          `SELECT bun_color_int(?1) AS colorInt,
                  bun_color_css(?1) AS colorCss`,
        )
        .get(input) as { colorInt: number | bigint; colorCss: string };
      expect(Number(parsed.colorInt)).toBe(0xff0000);
      expect(parsed.colorCss).toBe("red");
    }
  });

  test("NULL and unparseable inputs abort the statement with ERR_COLOR_INVALID", () => {
    const { db } = freshDb();

    expect(() => db.query(INSERT_BAD_COLOR).run("p2")).toThrow(
      /ERR_COLOR_INVALID/,
    );
    expect(() =>
      db
        .query(
          `INSERT INTO profile_themes
             (profile_id, color_int, color_css, color_label, updated_at_ms)
           VALUES ('p3', bun_color_int('notacolor'), 'red', 'red', 1)`,
        )
        .run(),
    ).toThrow(/ERR_COLOR_INVALID/);
    expect(() =>
      db
        .query(
          `INSERT INTO profile_themes
             (profile_id, color_int, color_css, color_label, updated_at_ms)
           VALUES ('p4', 16711680, bun_color_css(NULL), 'red', 1)`,
        )
        .run(),
    ).toThrow(/ERR_COLOR_INVALID/);

    // A failed statement writes no row at all.
    expect(countRows(db)).toBe(0);
  });

  test("a bad row rolls back the good insert in the same transaction", () => {
    const { db } = freshDb();
    const insertGood = (profileId: string): void => {
      db.query(INSERT_THEME).run(profileId, "red");
    };
    const insertBad = (profileId: string): void => {
      db.query(INSERT_BAD_COLOR).run(profileId);
    };

    const transaction = db.transaction(() => {
      insertGood("p3");
      insertBad("p4");
    });
    expect(() => transaction()).toThrow(/ERR_COLOR_INVALID/);

    const ids = db
      .query("SELECT profile_id FROM profile_themes")
      .all()
      .map((row) => String((row as { profile_id: string }).profile_id));
    expect(ids).toEqual([]);
  });

  test("both UDFs are registered with SQLITE_DETERMINISTIC (flag 0x800)", () => {
    const { db } = freshDb();
    const functions = db.query("PRAGMA function_list").all() as Array<{
      name: string;
      flags: number | bigint;
    }>;
    for (const name of ["bun_color_int", "bun_color_css"]) {
      const entry = functions.find((row) => row.name === name);
      if (entry === undefined) throw new Error(`UDF not registered: ${name}`);
      expect(Number(entry.flags) & 0x800).toBe(0x800);
    }
  });
});

describe("attachThemeSyncHooks", () => {
  test("each write runs exactly one serialized sync and idle() waits", async () => {
    const { db } = freshDb();
    const targets = makeTargets();
    const state = freshState();
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const fakeSync = async (): Promise<boolean> => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Bun.sleep(2);
      runs += 1;
      concurrent -= 1;
      return true;
    };
    const controller = attach(db, state, targets, { sync: fakeSync });

    insertTheme(db, "p1");
    await controller.idle();
    expect(runs).toBe(1);
    expect(controller.syncs).toBe(1);

    db.query(
      "UPDATE profile_themes SET color_label = 'blue' WHERE profile_id = 'p1'",
    ).run();
    await controller.idle();
    expect(runs).toBe(2);
    expect(controller.syncs).toBe(2);

    db.query("DELETE FROM profile_themes WHERE profile_id = 'p1'").run();
    await controller.idle();
    expect(runs).toBe(3);
    expect(controller.syncs).toBe(3);
    expect(maxConcurrent).toBe(1);
  });

  test("a burst of writes coalesces into one running serialized sync", async () => {
    const { db } = freshDb();
    const targets = makeTargets();
    const state = freshState();
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const fakeSync = async (): Promise<boolean> => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Bun.sleep(2);
      runs += 1;
      concurrent -= 1;
      return true;
    };
    const controller = attach(db, state, targets, { sync: fakeSync });

    insertTheme(db, "p1");
    for (let index = 0; index < 5; index += 1) {
      db.query(
        "UPDATE profile_themes SET color_label = ?1 WHERE profile_id = 'p1'",
      ).run(`label-${index}`);
    }
    await controller.idle();

    expect(maxConcurrent).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(runs).toBeLessThan(5);
    expect(controller.syncs).toBe(runs);
  });

  test("attach is once-only; stop() detaches and allows a reattach", async () => {
    const { db } = freshDb();
    const targets = makeTargets();
    const state = freshState();
    const fakeSync = async (): Promise<boolean> => true;
    const first = attach(db, state, targets, { sync: fakeSync });

    expect(() =>
      attachThemeSyncHooks(db, state, targets, { sync: fakeSync }),
    ).toThrow(/ERR_THEME_HOOKS_ATTACHED/);

    insertTheme(db, "p1");
    await first.idle();
    expect(first.syncs).toBe(1);

    first.stop();
    expect(db.onInsert).toBeNull();
    expect(db.onUpdate).toBeNull();
    expect(db.onDelete).toBeNull();

    insertTheme(db, "p2");
    await Bun.sleep(5);
    expect(first.syncs).toBe(1);

    const second = attach(db, state, targets, { sync: fakeSync });
    insertTheme(db, "p3");
    await second.idle();
    expect(second.syncs).toBe(1);
  });

  test("a sync error rejects idle() and the next trigger still runs", async () => {
    const { db } = freshDb();
    const targets = makeTargets();
    const state = freshState();
    const errors: unknown[] = [];
    let calls = 0;
    const failingSync = async (): Promise<boolean> => {
      calls += 1;
      if (calls === 1) throw new Error("ERR_THEME_SYNC_FAILED: transient");
      return true;
    };
    const controller = attach(db, state, targets, {
      sync: failingSync,
      onError: (error) => errors.push(error),
    });

    insertTheme(db, "p1");
    await expect(controller.idle()).rejects.toThrow("ERR_THEME_SYNC_FAILED");
    expect(errors.length).toBe(1);
    expect(controller.syncs).toBe(0);

    db.query(
      "UPDATE profile_themes SET color_label = 'blue' WHERE profile_id = 'p1'",
    ).run();
    await controller.idle();
    expect(calls).toBe(2);
    expect(controller.syncs).toBe(1);
  });

  test("the default sync writes .env, .env.example and the theme LUT", async () => {
    const { db } = freshDb();
    const targets = makeTargets();
    const state = freshState();
    const controller = attach(db, state, targets);

    insertTheme(db, "p1", "desk-red");
    await controller.idle();
    expect(controller.syncs).toBe(1);

    for (const path of [
      targets.envPath,
      targets.envExamplePath,
      targets.themeGenPath,
    ]) {
      expect(await Bun.file(path).exists()).toBe(true);
    }

    const fingerprint = state.lastFingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const env = await Bun.file(targets.envPath).text();
    expect(env).toContain("# profile_id=p1");
    expect(env).toContain(`sha256: ${fingerprint}`);
    expect(env).toContain('PROFILE_P1_COLOR_LABEL="desk-red"');
    expect(env).toContain('PROFILE_P1_COLOR_CSS="red"');
    expect(env).toContain("PROFILE_P1_COLOR_INT=16711680");
    expect(env).toContain('PROFILE_P1_COLOR_HEX="#ff0000"');

    const example = await Bun.file(targets.envExamplePath).text();
    expect(example).toContain("# profile_id=p1");
    expect(example).toContain('PROFILE_P1_COLOR_LABEL="<label>"');
    expect(example).toContain(`sha256: ${fingerprint}`);

    const theme = await Bun.file(targets.themeGenPath).text();
    expect(theme).toContain(
      `THEME_SNAPSHOT_SHA256 = ${JSON.stringify(fingerprint)}`,
    );
    expect(theme).toContain('"p1": Object.freeze({');
    expect(theme).toContain("colorInt: 16711680");
    expect(theme).toContain('colorLabel: "desk-red"');
  });

  test("a pre-existing foreign hook is reported distinctly and preserved", () => {
    const { db } = freshDb();
    const targets = makeTargets();
    const state = freshState();
    let foreignCalls = 0;
    const foreign = (_database: Database, tableName: string): void => {
      if (tableName === "profile_themes") foreignCalls += 1;
    };
    db.onInsert = foreign;

    expect(() => attachThemeSyncHooks(db, state, targets)).toThrow(
      /ERR_THEME_HOOKS_FOREIGN/,
    );
    expect(db.onInsert).toBe(foreign);

    insertTheme(db, "p1");
    expect(foreignCalls).toBe(1);
    db.onInsert = null;
  });
});
