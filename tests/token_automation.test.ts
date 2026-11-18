import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutomatedDualTokenStore,
  runCodegenSubcommand,
} from "../lib/token_automation.ts";

test("stores both color_name and 24-bit color_number via Bun.color and emits .env + TS theme", async () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-tokens-"));
  const store = new AutomatedDualTokenStore(join(dir, "tokens.sqlite"));

  try {
    store.upsertProfile(
      "crimson-auto",
      { accent: "red", error: "red", warn: "gold", bg: "ivory" },
      { consoleDepth: 5, sorted: true },
    );

    const rows = store.getRows("crimson-auto");
    const accentRow = rows.find((row) => row.role === "accent")!;
    expect(accentRow.color_name).toBe("red");
    expect(accentRow.color_number).toBe(0xff0000); // 16711680
    expect(accentRow.hex).toBe("#ff0000");

    const { envFile, tsFile, bundle } = await store.emitArtifacts(
      "crimson-auto",
      dir,
      {
        env: { FORCE_COLOR: "3" },
        isTTY: true,
      },
    );

    // 1. A light background ("ivory") sets AnsiTheme.light automatically.
    expect(bundle.ansiTheme.light).toBe(true);
    expect(bundle.ansiTheme.colors).toBe(true);

    // 2. The .env carries both the human name and the 24-bit integer, plus expansion.
    const envContent = await Bun.file(envFile).text();
    expect(envContent).toContain('PTY_ACCENT="red"');
    expect(envContent).toContain("PTY_ACCENT_NUMBER=16711680");
    expect(envContent).toContain("PTY_ERROR=$PTY_ACCENT");
    expect(envContent).toContain("PTY_ERROR_NUMBER=$PTY_ACCENT_NUMBER");

    // 3. The generated TypeScript LUT imports cleanly and matches Bun.color's SGR output.
    const module = await import(tsFile);
    expect(module.GENERATED_PROFILE_CRIMSON_AUTO.tokens.accent.name).toBe(
      "red",
    );
    expect(module.GENERATED_PROFILE_CRIMSON_AUTO.tokens.accent.number).toBe(
      0xff0000,
    );
    expect(module.GENERATED_PROFILE_CRIMSON_AUTO.tokens.accent.ansi16m).toBe(
      Bun.color("red", "ansi-16m"),
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generated render callbacks emit the stored escapes and OSC-8 links", () => {
  const store = new AutomatedDualTokenStore(":memory:", false);
  try {
    store.upsertProfile(
      "incident",
      {
        accent: "red",
        error: "red",
        warn: "gold",
        info: "dodgerblue",
        code: "orange",
      },
      { consoleDepth: 3 },
    );
    const bundle = store.generateBundle("incident", {
      env: { FORCE_COLOR: "3" },
      isTTY: true,
    });
    const rendered = store.renderMarkdown(
      "**bold** and `code` and [link](https://example.com)",
      bundle,
    );

    expect(rendered).toContain("\x1b[1m");
    expect(rendered).toContain("\x1b]8;;https://example.com");
    expect(bundle.ansiTheme.hyperlinks).toBe(true);
    expect(bundle.dotEnvText).toContain('BUN_OPTIONS="--console-depth=3"');
  } finally {
    store.close();
  }
});

test("unknown profiles and invalid colours fail closed", () => {
  const store = new AutomatedDualTokenStore(":memory:", false);
  try {
    expect(() => store.generateBundle("nope")).toThrow("ERR_PROFILE_NOT_FOUND");
    expect(() => store.upsertToken("p", "accent", "not-a-colour")).toThrow(
      "ERR_COLOR_INVALID",
    );
  } finally {
    store.close();
  }
});

test("codegen subcommand writes both artifacts and exits 2 on an unknown profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codegen-"));
  const dbPath = join(dir, "tokens.sqlite");
  const outDir = join(dir, "generated");
  const written = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    expect(
      await runCodegenSubcommand(dbPath, [
        "--profile",
        "crimson-dry",
        "--out-dir",
        outDir,
      ]),
    ).toBe(0);
    expect(await Bun.file(join(outDir, ".env.crimson-dry")).text()).toContain(
      'PTY_PROFILE="crimson-dry"',
    );
    expect(
      await Bun.file(join(outDir, "crimson-dry.theme.gen.ts")).text(),
    ).toContain("GENERATED_PROFILE_CRIMSON_DRY");
    expect(
      await runCodegenSubcommand(dbPath, [
        "--profile",
        "missing",
        "--out-dir",
        outDir,
      ]),
    ).toBe(2);
  } finally {
    process.stdout.write = written;
    rmSync(dir, { recursive: true, force: true });
  }
});
