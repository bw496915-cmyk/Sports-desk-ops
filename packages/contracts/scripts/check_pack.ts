#!/usr/bin/env bun
/**
 * @file packages/contracts/scripts/check_pack.ts
 * @description End-to-end publish proof: pack the tarball, extract it into a throwaway consumer,
 * and verify both conditions.
 *
 *  - `bun` (src): the consumer typechecks **without** `allowArbitraryExtensions` and runs the
 *    loader against the packed `src/tokens.toml`.
 *  - `default` (dist): the bundled `dist/index.js` runs with no package files needed.
 *
 * `bun pm pack` runs `prepack` (sync + build), so this checks the artifact a consumer installs,
 * not the working tree. Usage: `bun run check:pack` (`--keep` leaves the temp dir).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PKG_DIR = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PKG_DIR, "../..");
const KEEP = process.argv.includes("--keep");

const REQUIRED_FILES = [
  "package.json",
  "src/index.ts",
  "src/tokens.toml",
  "src/tokens.loader.js",
  "src/tokens.loader.d.ts",
  "dist/index.js",
] as const;

function run(cmd: string, args: readonly string[], cwd: string): void {
  const result = Bun.spawnSync([cmd, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${String(result.exitCode)}`,
    );
  }
}

function writeConsumer(consumerDir: string, packageDir: string): void {
  const distEntry = pathToFileURL(join(packageDir, "dist/index.js")).href;
  writeFileSync(
    join(consumerDir, "consumer.ts"),
    `import { CHANNEL_TOKEN_MAP, classifyTicketWriter } from "@sportsdesk-ops/contracts";

const classified = classifyTicketWriter("GSBUILDER   ");
if (
  classified.family !== "gsbuilder" ||
  classified.surface !== "gsbuilder" ||
  classified.disposition !== "counted"
) {
  throw new Error(\`bad classification: \${JSON.stringify(classified)}\`);
}
if (CHANNEL_TOKEN_MAP.size < 11) throw new Error("channel map is incomplete");
console.log("bun-condition-ok", classified.channel, classified.family);
`,
  );
  writeFileSync(
    join(consumerDir, "dist_consumer.ts"),
    `import { classifyTicketWriter } from ${JSON.stringify(distEntry)};

const classified = classifyTicketWriter("GSLIVE");
if (classified.family !== "gslive") {
  throw new Error(\`bad dist classification: \${JSON.stringify(classified)}\`);
}
console.log("default-condition-ok", classified.channel, classified.family);
`,
  );
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          lib: ["ESNext"],
          module: "Preserve",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          types: ["bun"],
          typeRoots: [join(REPO_ROOT, "node_modules/@types")],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "contracts-pack-"));
  try {
    const tarballDir = join(work, "tarball");
    const consumerDir = join(work, "consumer");
    const packageDir = join(
      consumerDir,
      "node_modules",
      "@sportsdesk-ops",
      "contracts",
    );
    mkdirSync(tarballDir, { recursive: true });
    mkdirSync(packageDir, { recursive: true });

    run("bun", ["pm", "pack", "--destination", tarballDir, "--quiet"], PKG_DIR);
    const tarball = readdirSync(tarballDir).find((name) =>
      name.endsWith(".tgz"),
    );
    if (tarball === undefined) throw new Error("pack produced no .tgz");
    run(
      "tar",
      [
        "-xzf",
        join(tarballDir, tarball),
        "-C",
        packageDir,
        "--strip-components",
        "1",
      ],
      work,
    );

    for (const file of REQUIRED_FILES) {
      if (!existsSync(join(packageDir, file))) {
        throw new Error(`packed tarball is missing ${file}`);
      }
    }

    const leakedTests = [
      ...new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}").scanSync(packageDir),
    ];
    if (leakedTests.length > 0) {
      throw new Error(
        `packed tarball leaked test file(s): ${leakedTests.join(", ")}`,
      );
    }

    writeConsumer(consumerDir, packageDir);
    run("bun", ["check", "consumer.ts"], consumerDir);
    run("bun", ["consumer.ts"], consumerDir);
    run("bun", ["dist_consumer.ts"], consumerDir);

    console.log(
      "[check:pack] ok: tarball contents, bun + dist runtime, types without allowArbitraryExtensions",
    );
  } finally {
    if (KEEP) {
      console.log(`[check:pack] kept ${work}`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[check:pack] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
