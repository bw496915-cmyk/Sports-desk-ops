/**
 * Fail CI/dev if tsconfig.json drifts away from the repo's strict typing baseline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const tsconfigPath = join(ROOT, "tsconfig.json");

type CompilerOptions = Record<string, unknown>;

const REQUIRED: Record<string, unknown> = {
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  noImplicitReturns: true,
  strictBuiltinIteratorReturn: true,
  useUnknownInCatchVariables: true,
  forceConsistentCasingInFileNames: true,
  exactOptionalPropertyTypes: true,
  verbatimModuleSyntax: true,
  moduleDetection: "force",
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
};

function main(): number {
  const raw = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
    compilerOptions?: CompilerOptions;
  };
  const opts = raw.compilerOptions ?? {};
  const missing: string[] = [];
  const wrong: string[] = [];

  for (const [key, expected] of Object.entries(REQUIRED)) {
    if (!(key in opts)) {
      missing.push(key);
      continue;
    }
    if (opts[key] !== expected) {
      wrong.push(
        `${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(opts[key])}`,
      );
    }
  }

  if (missing.length === 0 && wrong.length === 0) {
    console.log("ensure_deep_tsconfig: ok");
    return 0;
  }

  console.error(
    "ensure_deep_tsconfig: tsconfig.json is not at deep strict baseline",
  );
  for (const k of missing) console.error(`  missing compilerOptions.${k}`);
  for (const line of wrong) console.error(`  ${line}`);
  return 1;
}

process.exit(main());
