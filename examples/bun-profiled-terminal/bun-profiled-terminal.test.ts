/**
 * @file examples/bun-profiled-terminal/bun-profiled-terminal.test.ts
 * @description Contract tests for the profiled terminal engine. PTY cases are skipped when the
 * host cannot open `/dev/ptmx` (the same skip pattern as `tests/pty_injection.test.ts`), so the
 * suite still runs inside a file sandbox while exercising the real PTY path on a capable host.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  NamedColorTokenStore,
  DEFAULT_INSPECT_SETTINGS,
  applyProfileToHost,
  buildMarkdownAnsiTheme,
  createProfiledTerminal,
  deriveColorToken,
  detectColorDepth,
  formatConsoleArguments,
  inspectValue,
  normalizeConsoleDepth,
  normalizeNamedColor,
  probePtySupport,
  profileInspectFormatter,
  resolveTerminalProfile,
  runProfiledPtySession,
} from "./bun-profiled-terminal.ts";

const modulePath = join(import.meta.dir, "bun-profiled-terminal.ts");
const pty = probePtySupport();

function makeProfile(
  options: Parameters<typeof resolveTerminalProfile>[0] = {},
) {
  return resolveTerminalProfile({
    profile: "compact-ci",
    isTTY: false,
    env: { NO_COLOR: "1", FORCE_COLOR: "0" },
    ...options,
  });
}

function truecolorProfile(store?: NamedColorTokenStore) {
  return resolveTerminalProfile({
    profile: "deep-forensics",
    store,
    isTTY: true,
    env: { NO_COLOR: undefined, FORCE_COLOR: "3" },
  });
}

// ============================================================================
// Normalization & color derivation
// ============================================================================

describe("normalization", () => {
  test("normalizes named colors and rejects unknown ones", () => {
    expect(normalizeNamedColor("  RED ")).toBe("red");
    expect(normalizeNamedColor("DodgerBlue")).toBe("dodgerblue");
    expect(normalizeNamedColor("not-a-color")).toBeNull();
    expect(normalizeNamedColor("")).toBeNull();
    expect(normalizeNamedColor(undefined)).toBeNull();
  });

  test("accepts infinity spellings and rejects negatives/fractions", () => {
    expect(normalizeConsoleDepth(Infinity)).toBe(Infinity);
    expect(normalizeConsoleDepth("Infinity")).toBe(Infinity);
    expect(normalizeConsoleDepth("inf")).toBe(Infinity);
    expect(normalizeConsoleDepth("0")).toBe(0);
    expect(normalizeConsoleDepth(5)).toBe(5);
    expect(normalizeConsoleDepth(-1)).toBeNull();
    expect(normalizeConsoleDepth(1.5)).toBeNull();
    expect(normalizeConsoleDepth("nan")).toBeNull();
  });

  test("derives channels, hex, CSS, SGR, OSC and WCAG contrast", () => {
    const token = deriveColorToken("accent", "red", "ansi-16m");
    expect(token.name).toBe("red");
    expect(token.number).toBe(0xff0000);
    expect(token.hex).toBe("#ff0000");
    expect(token.css).toBe("red");
    expect([token.r, token.g, token.b]).toEqual([255, 0, 0]);
    expect(token.ansiFg).toBe("\x1b[38;2;255;0;0m");
    expect(token.ansiBg).toBe("\x1b[48;2;255;0;0m");
    expect(token.osc10).toBe("\x1b]10;#ff0000\x07");
    expect(token.osc11).toBe("\x1b]11;#ff0000\x07");
    expect(token.contrastFgName).toBe("black");
  });

  test("derives ansi-16 background SGR and nulls ANSI when depth is none", () => {
    const sixteen = deriveColorToken("error", "red", "ansi-16");
    expect(sixteen.ansiFg).toBe("\x1b[91m");
    expect(sixteen.ansiBg).toBe("\x1b[101m");

    const monochrome = deriveColorToken("error", "red", null);
    expect(monochrome.ansiFg).toBe("");
    expect(monochrome.ansiBg).toBe("");
    expect(monochrome.hex).toBe("#ff0000");
  });

  test("throws on invalid colors", () => {
    expect(() => deriveColorToken("accent", "nope", "ansi-16m")).toThrow(
      /ERR_COLOR_INVALID/,
    );
  });

  test("detects color depth from NO_COLOR, FORCE_COLOR, COLORTERM and TERM", () => {
    expect(detectColorDepth({ NO_COLOR: "1" }, true)).toBe("none");
    expect(detectColorDepth({ NO_COLOR: "" }, true)).toBe("truecolor");
    expect(detectColorDepth({ FORCE_COLOR: "1" }, false)).toBe("ansi16");
    expect(detectColorDepth({ FORCE_COLOR: "2" }, false)).toBe("ansi256");
    expect(detectColorDepth({ FORCE_COLOR: "0" }, true)).toBe("none");
    expect(detectColorDepth({ COLORTERM: "truecolor" }, false)).toBe(
      "truecolor",
    );
    expect(detectColorDepth({ TERM: "xterm-256color" }, true)).toBe("ansi256");
    expect(detectColorDepth({ TERM: "dumb" }, true)).toBe("none");
    expect(detectColorDepth({}, false)).toBe("none");
    expect(detectColorDepth({}, true)).toBe("truecolor");
  });
});

// ============================================================================
// Store: settings, clone, diff, watch
// ============================================================================

describe("NamedColorTokenStore", () => {
  test("seeds the builtin presets with inspect settings", () => {
    const store = new NamedColorTokenStore(":memory:");
    try {
      expect(store.getTokenName("default", "accent")).toBe("dodgerblue");
      expect(store.getInspectSettings("default")).toEqual(
        DEFAULT_INSPECT_SETTINGS,
      );
      expect(store.getInspectSettings("compact-ci")).toMatchObject({
        consoleDepth: 1,
        sorted: true,
        compact: true,
        maxArrayLength: 25,
        maxStringLength: 80,
      });
      expect(store.listProfiles()).toContain("incident-red");
    } finally {
      store.close();
    }
  });

  test("setToken canonicalizes, validates and notifies once", () => {
    const store = new NamedColorTokenStore(":memory:", false);
    try {
      const seen: string[] = [];
      const stop = store.watchProfile((profile) => seen.push(profile));
      expect(store.setToken("ops", "accent", "RED")).toBe("red");
      expect(store.getTokenName("ops", "accent")).toBe("red");
      // Same value: no write, no notification.
      store.setToken("ops", "accent", "red");
      expect(seen).toEqual(["ops"]);
      expect(() => store.setToken("ops", "accent", "nope")).toThrow(
        /ERR_COLOR_INVALID/,
      );
      stop();
    } finally {
      store.close();
    }
  });

  test("setInspectSettings merges, round-trips Infinity and rejects bad limits", () => {
    const store = new NamedColorTokenStore(":memory:", false);
    try {
      const initial = store.setInspectSettings("audit", {
        consoleDepth: 5,
        sorted: true,
        maxArrayLength: 250,
        maxStringLength: 500,
      });
      expect(initial).toMatchObject({
        consoleDepth: 5,
        sorted: true,
        compact: false,
        maxArrayLength: 250,
        maxStringLength: 500,
      });

      expect(store.setConsoleDepth("audit", Infinity)).toBe(Infinity);
      expect(store.getInspectSettings("audit")?.consoleDepth).toBe(Infinity);

      const merged = store.setInspectSettings("audit", { maxStringLength: 12 });
      expect(merged.consoleDepth).toBe(Infinity);
      expect(merged.maxStringLength).toBe(12);

      expect(() =>
        store.setInspectSettings("audit", { maxArrayLength: -1 }),
      ).toThrow(/ERR_MAX_ARRAY_LENGTH_INVALID/);
      expect(() =>
        store.setInspectSettings("audit", { consoleDepth: -1 }),
      ).toThrow(/ERR_CONSOLE_DEPTH_INVALID/);
    } finally {
      store.close();
    }
  });

  test("setProfile rolls back all rows when a later color is invalid", () => {
    const store = new NamedColorTokenStore(":memory:", false);
    try {
      expect(() =>
        store.setProfile(
          "atomic",
          { accent: "red", error: "definitely-not-a-color" },
          { consoleDepth: 4 },
        ),
      ).toThrow(/ERR_COLOR_INVALID/);
      expect(store.getProfileMap("atomic")).toEqual({});
      expect(store.getInspectSettings("atomic")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("cloneProfile copies the effective profile and replaces the target", () => {
    const store = new NamedColorTokenStore(":memory:");
    try {
      store.setProfile(
        "source",
        { accent: "red" },
        { consoleDepth: 5, sorted: true, maxArrayLength: 250 },
      );
      store.cloneProfile("source", "copy");

      expect(store.getTokenName("copy", "accent")).toBe("red");
      // Effective fallback roles are materialised too, so the copy looks identical.
      expect(store.getTokenName("copy", "error")).toBe(
        store.getTokenName("default", "error"),
      );
      expect(store.getInspectSettings("copy")).toEqual(
        store.getInspectSettings("source"),
      );

      const source = resolveTerminalProfile({
        profile: "source",
        store,
        isTTY: false,
        env: { NO_COLOR: "1" },
      });
      const copy = resolveTerminalProfile({
        profile: "copy",
        store,
        isTTY: false,
        env: { NO_COLOR: "1" },
      });
      expect(
        Object.fromEntries(
          Object.entries(copy.tokens).map(([role, token]) => [
            role,
            token?.name,
          ]),
        ),
      ).toEqual(
        Object.fromEntries(
          Object.entries(source.tokens).map(([role, token]) => [
            role,
            token?.name,
          ]),
        ),
      );

      expect(() => store.cloneProfile("missing-everywhere", "x")).toThrow(
        /ERR_PROFILE_UNKNOWN/,
      );
      expect(() => store.cloneProfile("source", "source")).toThrow(
        /ERR_PROFILE_CLONE_SELF/,
      );
    } finally {
      store.close();
    }
  });

  test("diffProfiles renders a Markdown table with every inspect field", () => {
    const store = new NamedColorTokenStore(":memory:");
    try {
      store.setProfile(
        "diffy",
        { accent: "red", error: "crimson" },
        {
          consoleDepth: 6,
          sorted: true,
          maxArrayLength: 500,
          maxStringLength: 2_000,
        },
      );
      const diff = store.diffProfiles("default", "diffy");
      expect(diff).toContain("## Profile diff");
      expect(diff).toContain("`consoleDepth`");
      expect(diff).toContain("`maxArrayLength`");
      expect(diff).toContain("`maxStringLength`");
      expect(diff).toContain("`accent`");
      expect(diff).toContain("**YES**");
      expect(diff).toContain("`2`");
      expect(diff).toContain("`6`");
      // Missing roles inherit the default preset, so they are not reported as "(unset)".
      expect(diff).toContain("`slategray`");

      const unknown = store.diffProfiles("default", "no-such-profile");
      expect(unknown).toContain("no stored rows or builtin preset");
      expect(() => store.diffProfiles("nope-a", "nope-b")).toThrow(
        /ERR_PROFILE_UNKNOWN/,
      );
    } finally {
      store.close();
    }
  });

  test("watchProfile notifies after commit, supports unsubscribe and blocks reentrancy", () => {
    const store = new NamedColorTokenStore(":memory:", false);
    try {
      const seen: string[] = [];
      const stop = store.watchProfile((profile) => seen.push(profile));
      store.setProfile("watched", { accent: "red" }, { consoleDepth: 3 });
      expect(seen).toEqual(["watched"]);

      store.setToken("watched", "error", "crimson");
      store.setConsoleDepth("watched", 4);
      expect(seen).toEqual(["watched", "watched", "watched"]);

      stop();
      stop();
      store.setToken("watched", "info", "coral");
      expect(seen).toEqual(["watched", "watched", "watched"]);

      // A listener that mutates the store fails without corrupting the committed write.
      const stopReentrant = store.onProfileChange(() => {
        store.setToken("watched", "warn", "gold");
      });
      expect(() => store.setToken("watched", "muted", "gray")).toThrow(
        /ERR_STORE_REENTRANT/,
      );
      stopReentrant();
      expect(store.getTokenName("watched", "muted")).toBe("gray");
    } finally {
      store.close();
    }
  });

  test("toEnvRecord exports colors, inspect flags and Infinity", () => {
    const store = new NamedColorTokenStore(":memory:", false);
    try {
      store.setProfile(
        "env-profile",
        { accent: "red" },
        {
          consoleDepth: Infinity,
          sorted: true,
          compact: true,
          maxArrayLength: 7,
          maxStringLength: Infinity,
        },
      );
      const env = store.toEnvRecord("env-profile");
      expect(env.PTY_PROFILE).toBe("env-profile");
      expect(env.PTY_ACCENT).toBe("red");
      expect(env.PTY_CONSOLE_DEPTH).toBe("Infinity");
      expect(env.PTY_MAX_ARRAY_LENGTH).toBe("7");
      expect(env.PTY_MAX_STRING_LENGTH).toBe("Infinity");
      expect(env.PTY_INSPECT_SORTED).toBe("1");
      expect(env.PTY_INSPECT_COMPACT).toBe("1");
    } finally {
      store.close();
    }
  });

  test("rejects use after close", () => {
    const store = new NamedColorTokenStore(":memory:");
    store.close();
    store.close();
    expect(() => store.listProfiles()).toThrow(/ERR_STORE_CLOSED/);
  });
});

// ============================================================================
// Inspect limits & console formatting
// ============================================================================

describe("inspect limits shim", () => {
  test("truncates nested arrays and strings at every plain-object level", () => {
    const settings = {
      ...DEFAULT_INSPECT_SETTINGS,
      consoleDepth: Infinity,
      maxArrayLength: 2,
      maxStringLength: 4,
    };
    const output = Bun.stripANSI(
      inspectValue(
        {
          first: [1, 2, 3],
          nested: { second: [4, 5, 6] },
          text: "abcdefgh",
        },
        settings,
        false,
      ),
    );
    expect(output).toContain("... 1 more items");
    expect(output.match(/more items/g)?.length).toBe(2);
    expect(output).toContain("… (4 more chars)");
    expect(output).toContain('"abcd');
    expect(output).not.toContain("efgh");
  });

  test("honours sorted, compact and depth", () => {
    const settings = {
      ...DEFAULT_INSPECT_SETTINGS,
      consoleDepth: Infinity,
      sorted: true,
    };
    const output = inspectValue({ z: 1, a: 2 }, settings, false);
    expect(output.indexOf("a:")).toBeLessThan(output.indexOf("z:"));

    const compact = inspectValue(
      { a: { b: 1 } },
      { ...settings, compact: true },
      false,
    );
    expect(compact).not.toContain("\n");

    const shallow = inspectValue(
      { a: { b: { c: "deep" } } },
      { ...settings, consoleDepth: 1 },
      false,
    );
    expect(shallow).toContain("[Object ...]");
  });

  test("does not clone class instances, Maps or typed arrays", () => {
    class Box {
      constructor(readonly values: number[]) {}
    }
    const box = new Box([1, 2, 3]);
    const map = new Map([["a", [1, 2, 3]]]);
    const bytes = new Uint8Array([1, 2, 3]);
    const settings = {
      ...DEFAULT_INSPECT_SETTINGS,
      consoleDepth: Infinity,
      maxArrayLength: 1,
    };
    const output = inspectValue({ box, map, bytes }, settings, false);
    expect(output).toContain("Box");
    expect(output).toContain("1, 2, 3");
  });

  test("formats console arguments with substitutions", () => {
    const profile = makeProfile();
    expect(formatConsoleArguments(["hello"], profile)).toBe("hello");
    expect(formatConsoleArguments(["a", "b"], profile)).toBe("a b");
    expect(formatConsoleArguments(["x=%s", "y"], profile)).toBe("x=y");
    expect(formatConsoleArguments(["n=%d", 42], profile)).toBe("n=42");
    expect(formatConsoleArguments(["100%%"], profile)).toBe("100%");
    expect(formatConsoleArguments(["%o", { a: 1 }], profile)).toContain("a: 1");
    expect(formatConsoleArguments(["x=%s"], profile)).toBe("x=%s");
  });
});

// ============================================================================
// Profile resolution, env export and rendering
// ============================================================================

describe("resolveTerminalProfile", () => {
  test("resolves builtin settings and colors", () => {
    const profile = makeProfile();
    expect(profile.profile).toBe("compact-ci");
    expect(profile.consoleDepth).toBe(1);
    expect(profile.inspectSettings).toEqual({
      consoleDepth: 1,
      sorted: true,
      compact: true,
      maxArrayLength: 25,
      maxStringLength: 80,
    });
    expect(profile.tokens.accent?.name).toBe("deepskyblue");
    expect(profile.depth).toBe("none");
    expect(profile.warnings).toEqual([]);
  });

  test("env beats the store, explicit overrides beat env", () => {
    const store = new NamedColorTokenStore(":memory:");
    try {
      store.setProfile("ops", { accent: "red" }, { consoleDepth: 3 });
      const fromStore = resolveTerminalProfile({
        profile: "ops",
        store,
        isTTY: false,
        env: { NO_COLOR: "1" },
      });
      expect(fromStore.consoleDepth).toBe(3);
      expect(fromStore.tokens.accent?.name).toBe("red");

      const fromEnv = resolveTerminalProfile({
        profile: "ops",
        store,
        isTTY: false,
        env: {
          NO_COLOR: "1",
          PTY_CONSOLE_DEPTH: "4",
          PTY_ACCENT: "blue",
          PTY_INSPECT_SORTED: "1",
          PTY_MAX_ARRAY_LENGTH: "9",
          PTY_MAX_STRING_LENGTH: "inf",
        },
      });
      expect(fromEnv.consoleDepth).toBe(4);
      expect(fromEnv.tokens.accent?.name).toBe("blue");
      expect(fromEnv.inspectSettings.sorted).toBe(true);
      expect(fromEnv.inspectSettings.maxArrayLength).toBe(9);
      expect(fromEnv.inspectSettings.maxStringLength).toBe(Infinity);

      const explicit = resolveTerminalProfile({
        profile: "ops",
        store,
        isTTY: false,
        env: { NO_COLOR: "1", PTY_CONSOLE_DEPTH: "4" },
        consoleDepth: 2,
        inspectOverrides: { consoleDepth: 1, compact: true },
        overrides: { accent: "gold" },
      });
      expect(explicit.consoleDepth).toBe(1);
      expect(explicit.inspectSettings.compact).toBe(true);
      expect(explicit.tokens.accent?.name).toBe("gold");
    } finally {
      store.close();
    }
  });

  test("invalid explicit overrides throw; invalid env values warn and fall back", () => {
    expect(() => makeProfile({ consoleDepth: -1 })).toThrow(
      /ERR_CONSOLE_DEPTH_INVALID/,
    );
    expect(() => makeProfile({ overrides: { accent: "nope" } })).toThrow(
      /ERR_COLOR_INVALID/,
    );

    const warned = resolveTerminalProfile({
      profile: "compact-ci",
      isTTY: false,
      env: {
        NO_COLOR: "1",
        PTY_ACCENT: "not-a-color",
        PTY_CONSOLE_DEPTH: "not-a-depth",
        PTY_INSPECT_SORTED: "maybe",
      },
    });
    expect(warned.tokens.accent?.name).toBe("deepskyblue");
    expect(warned.consoleDepth).toBe(1);
    expect(warned.inspectSettings.sorted).toBe(true);
    expect(warned.warnings.length).toBe(3);
  });

  test("unknown profiles fall back to default with a warning", () => {
    const profile = resolveTerminalProfile({
      profile: "does-not-exist",
      isTTY: false,
      env: { NO_COLOR: "1" },
    });
    expect(profile.warnings[0]).toContain("Unknown profile");
    expect(profile.tokens.accent?.name).toBe("dodgerblue");
    expect(profile.consoleDepth).toBe(2);
  });

  test("toEnv exports PTY_* and appends --console-depth once", () => {
    const profile = makeProfile();
    const env = profile.toEnv("");
    expect(env.PTY_PROFILE).toBe("compact-ci");
    expect(env.PTY_CONSOLE_DEPTH).toBe("1");
    expect(env.PTY_MAX_STRING_LENGTH).toBe("80");
    expect(env.BUN_OPTIONS).toBe("--console-depth=1");

    // The profile is authoritative over an inherited flag, in both directions.
    expect(profile.toEnv("--bun --console-depth=9").BUN_OPTIONS).toBe(
      "--bun --console-depth=1",
    );
    expect(
      makeProfile({ inspectOverrides: { consoleDepth: Infinity } }).toEnv(
        "--bun --console-depth=9",
      ).BUN_OPTIONS,
    ).toBe("--bun");
  });

  test("inspector overrideDepth validates and applies", () => {
    const profile = makeProfile();
    const value = { a: { b: { c: "deep" } } };
    expect(profile.inspect(value)).toContain("[Object ...]");
    expect(profile.inspect(value, Infinity)).toContain('"deep"');
    expect(() => profile.inspect(value, -2)).toThrow(
      /ERR_CONSOLE_DEPTH_INVALID/,
    );
  });
});

describe("rendering", () => {
  test("native AnsiTheme disables escapes when depth is none", () => {
    const profile = makeProfile();
    const theme = buildMarkdownAnsiTheme(profile.tokens, "none");
    expect(theme.colors).toBe(false);
    const output = Bun.markdown.ansi("**bold**", theme);
    expect(output).not.toContain("\x1b[");
  });

  test("profile card shows settings, swatches, sample and custom inspect", () => {
    const profile = truecolorProfile();
    const card = profile.renderProfileCard();
    expect(card).toContain("\x1b[38;2;");
    const plain = Bun.stripANSI(card);
    expect(plain).toContain("Terminal profile");
    expect(plain).toContain("Console depth");
    expect(plain).toContain("Max array length");
    expect(plain).toContain("BUN_OPTIONS");
    expect(plain).toContain("Sample object at consoleDepth");
    expect(plain).toContain("#ff0000");
    expect(Bun.inspect(profile)).toContain("Terminal profile");

    const target = {};
    Object.defineProperty(target, Bun.inspect.custom, {
      value: profileInspectFormatter(profile),
    });
    expect(Bun.inspect(target)).toContain("Terminal profile");
  });

  test("token-coloured render callbacks emit profile SGR", () => {
    const profile = truecolorProfile();
    const themed = profile.renderMarkdownThemed("**bold** and `code`");
    expect(themed).toContain("\x1b[38;2;");
    expect(themed).toContain("bold");
    const plain = makeProfile().renderMarkdownThemed("**bold**");
    expect(plain).not.toContain("\x1b[");
  });
});

// ============================================================================
// Host console synchronization (child process: it patches process globals)
// ============================================================================

describe("applyProfileToHost", () => {
  test("native console.log and Bun.inspect follow the profile, then restore", async () => {
    const script = `
      import { applyProfileToHost, resolveTerminalProfile } from ${JSON.stringify(modulePath)};
      const profile = resolveTerminalProfile({
        profile: "default",
        isTTY: false,
        env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      const nested = { l1: { l2: { l3: { l4: { l5: { l6: "deep" } } } } } };
      console.log("BEFORE-INSPECT", JSON.stringify(Bun.inspect(nested)));
      {
        using _host = applyProfileToHost(profile);
        console.log("DURING", nested);
        console.log("DURING-INSPECT", JSON.stringify(Bun.inspect(nested)));
        console.log("CUSTOM", typeof Bun.inspect.custom, typeof Bun.inspect.table);
      }
      console.log("AFTER-INSPECT", JSON.stringify(Bun.inspect(nested)));
    `;

    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        BUN_OPTIONS: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("error:");
    expect(stdout).toContain("CUSTOM symbol function");
    expect(stdout).toContain("DURING-INSPECT");
    expect(stdout).toContain("[Object ...]");

    const duringLine = stdout
      .split("\n")
      .find((line) => line.startsWith("DURING-INSPECT"))!;
    expect(duringLine).toContain("[Object ...]");

    const afterLine = stdout
      .split("\n")
      .find((line) => line.startsWith("AFTER-INSPECT"))!;
    expect(afterLine).toContain('\\"deep\\"');
    expect(afterLine).not.toContain("[Object ...]");
  });

  test("dispose is idempotent and restores method identities", () => {
    const profile = makeProfile();
    const beforeLog = console.log;
    const beforeInspect = Bun.inspect;
    const guard = applyProfileToHost(profile);
    expect(console.log).not.toBe(beforeLog);
    expect(Bun.inspect).not.toBe(beforeInspect);
    guard[Symbol.dispose]();
    guard[Symbol.dispose]();
    expect(console.log).toBe(beforeLog);
    expect(Bun.inspect).toBe(beforeInspect);
  });
});

// ============================================================================
// PTY path (skipped when the host cannot allocate a PTY)
// ============================================================================

describe.skipIf(!pty.available)("runProfiledPtySession", () => {
  test("runs a child with PTY_* env and profile console depth", async () => {
    const store = new NamedColorTokenStore(":memory:");
    try {
      store.setProfile(
        "pty-test",
        { accent: "red", warn: "gold" },
        { consoleDepth: 3, sorted: true, maxArrayLength: 25 },
      );
      const profile = resolveTerminalProfile({
        profile: "pty-test",
        store,
        isTTY: false,
        env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      });

      const child = [
        'console.log("ENV", process.env.PTY_PROFILE, process.env.PTY_ACCENT, process.env.PTY_CONSOLE_DEPTH);',
        'console.log({ l1: { l2: { l3: { l4: { l5: "deep" } } } } });',
      ].join("\n");

      const result = await runProfiledPtySession({
        profile,
        cmd: ["bun", "-e", child],
        env: { BUN_OPTIONS: "" },
        interactive: false,
        captureOutput: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBeNull();
      expect(result.aborted).toBe(false);
      expect(result.captureTruncated).toBe(false);
      expect(result.consoleDepth).toBe(3);
      expect(result.rawOutput).toContain("ENV pty-test red 3");
      // depth 3 -> l4 is truncated; BUN_OPTIONS carried --console-depth=3.
      expect(result.cleanOutput).toContain("l4: [Object ...]");
      expect(result.transcriptBlob.size).toBeGreaterThan(0);
      expect(await result.transcriptBlob.text()).toBe(result.rawOutput);
    } finally {
      store.close();
    }
  });

  test("captures at most maxCaptureBytes and reports truncation", async () => {
    const profile = makeProfile();
    const result = await runProfiledPtySession({
      profile,
      cmd: ["bun", "-e", 'process.stdout.write("x".repeat(4096));'],
      env: { BUN_OPTIONS: "" },
      interactive: false,
      captureOutput: true,
      maxCaptureBytes: 100,
    });
    expect(result.exitCode).toBe(0);
    expect(result.captureTruncated).toBe(true);
    expect(result.rawOutput.length).toBeLessThanOrEqual(100);
  });

  test("wall timeout escalates SIGTERM and reports timedOut", async () => {
    const profile = makeProfile();
    const result = await runProfiledPtySession({
      profile,
      cmd: ["bun", "-e", "setInterval(() => {}, 1000);"],
      env: { BUN_OPTIONS: "" },
      interactive: false,
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe("wall");
    expect(result.signal).toBe("SIGTERM");
    expect(result.exitCode).toBe(143);
  }, 10_000);

  test("rejects unknown executables and pre-aborted signals", async () => {
    const profile = makeProfile();
    await expect(
      runProfiledPtySession({
        profile,
        cmd: ["definitely-not-a-real-binary-xyz"],
        interactive: false,
      }),
    ).rejects.toThrow(/ERR_PTY_NOT_FOUND/);

    const controller = new AbortController();
    controller.abort();
    await expect(
      runProfiledPtySession({
        profile,
        cmd: ["bun", "-e", "console.log(1)"],
        signal: controller.signal,
        interactive: false,
      }),
    ).rejects.toThrow(/ERR_PTY_ABORTED/);
  });

  test("createProfiledTerminal captures raw and clean blobs", async () => {
    const profile = makeProfile();
    const handle = createProfiledTerminal(profile, { cols: 80, rows: 24 });
    try {
      const proc = Bun.spawn(
        ["bun", "-e", 'console.log("HANDLE", process.env.PTY_PROFILE);'],
        {
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
          terminal: handle.terminal,
        },
      );
      await proc.exited;
      const raw = await handle.toBlob().text();
      expect(raw).toContain("HANDLE");
      const clean = await (await handle.toCleanTextBlob()).text();
      expect(clean).toContain("HANDLE");
      expect(clean).not.toContain("\x1b[");
    } finally {
      if (!handle.terminal.closed) handle.terminal.close();
    }
  }, 10_000);
});

if (!pty.available) {
  test("PTY path skipped on this host", () => {
    expect(pty.available).toBe(false);
    expect(pty.error).toBeTruthy();
  });
}
