#!/usr/bin/env bun
/**
 * @file scripts/audit_customer_book.ts
 * @description Reports data-quality defects in the customer book.
 *
 * Usage:
 *   bun run scripts/audit_customer_book.ts [--book <path>] [--json] [--max 20]
 *
 * Exit: 0 clean, 1 issues found, 2 book missing/unreadable.
 */

import {
  auditCustomerBook,
  type CustomerBookIssue,
} from "../lib/customer_book_audit.ts";

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
const json = args.includes("--json");
const maxPrinted = Math.max(1, Number(flag(args, ["--max"], "20")));

if (!(await Bun.file(bookPath).exists())) {
  console.error(
    `audit: ${bookPath} not found (the book is gitignored customer data)`,
  );
  process.exit(2);
}

const parsed: unknown = await Bun.file(bookPath).json();
if (!Array.isArray(parsed)) {
  console.error(`audit: ${bookPath} is not a JSON array`);
  process.exit(2);
}

const audit = auditCustomerBook(parsed);
if (json) {
  console.log(JSON.stringify({ book: bookPath, ...audit }, null, 2));
} else {
  console.log(`customer book: ${bookPath}`);
  console.log(
    `  customers ${audit.customers} | tickets ${audit.tickets} | issues ${audit.issues.length}`,
  );
  for (const [kind, count] of Object.entries(audit.byKind)) {
    if (count > 0) console.log(`  ${kind.padEnd(24)} ${count}`);
  }
  const order: CustomerBookIssue[] = [...audit.issues].sort((a, b) =>
    a.kind.localeCompare(b.kind),
  );
  for (const issue of order.slice(0, maxPrinted)) {
    console.log(`    • [${issue.kind}] ${issue.customerId} — ${issue.detail}`);
  }
  if (order.length > maxPrinted)
    console.log(`    … ${order.length - maxPrinted} more`);
}

process.exitCode = audit.issues.length > 0 ? 1 : 0;
