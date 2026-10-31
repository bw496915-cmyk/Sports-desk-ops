#!/usr/bin/env bun
/**
 * @file scripts/normalize_customer_book.ts
 * @description Repairs ticket nets and hold_pct in the demo customer book.
 *
 * Usage:
 *   bun run scripts/normalize_customer_book.ts                 # dry-run, prints changes
 *   bun run scripts/normalize_customer_book.ts --write         # backup + write
 *   bun run scripts/normalize_customer_book.ts --json [--write]
 *
 * Exit: 0 nothing to do (or written), 1 changes pending in dry-run, 2 unreadable book.
 */

import { normalizeCustomerBook } from "../lib/customer_book_normalize.ts";

function flag(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

const args = process.argv.slice(2);
const bookPath = flag(args, ["--book"], "enriched_customers_full.json");
const write = args.includes("--write");
const json = args.includes("--json");
const maxPrinted = Math.max(1, Number(flag(args, ["--max"], "20")));

if (!(await Bun.file(bookPath).exists())) {
  console.error(`normalize: ${bookPath} not found (gitignored customer data)`);
  process.exit(2);
}
const parsed: unknown = await Bun.file(bookPath).json();
if (!Array.isArray(parsed)) {
  console.error(`normalize: ${bookPath} is not a JSON array`);
  process.exit(2);
}

const result = normalizeCustomerBook(parsed);
const byKind = result.changes.reduce<Record<string, number>>((acc, change) => {
  acc[change.kind] = (acc[change.kind] ?? 0) + 1;
  return acc;
}, {});

if (write && result.changes.length > 0) {
  const backupPath = flag(
    args,
    ["--backup"],
    `scratch/${bookPath.split("/").pop()}.bak`,
  );
  await Bun.write(backupPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await Bun.write(bookPath, `${JSON.stringify(result.rows, null, 2)}\n`);
  if (!json) console.log(`backup: ${backupPath}`);
} else if (!json && result.changes.length > 0) {
  console.log("dry-run (pass --write to apply)");
}

if (json) {
  console.log(
    JSON.stringify(
      { book: bookPath, written: write, changes: result.changes, byKind },
      null,
      2,
    ),
  );
} else {
  console.log(`customer book: ${bookPath}`);
  console.log(`  changes ${result.changes.length} | ${JSON.stringify(byKind)}`);
  for (const change of result.changes.slice(0, maxPrinted)) {
    console.log(
      `    • [${change.kind}] ${change.customerId}${change.label ? "/" + change.label : ""}: ${change.before} -> ${change.after}`,
    );
  }
  if (result.changes.length > maxPrinted) {
    console.log(`    … ${result.changes.length - maxPrinted} more`);
  }
}

process.exitCode = write ? 0 : result.changes.length > 0 ? 1 : 0;
