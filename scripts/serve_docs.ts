#!/usr/bin/env bun
/**
 * @file scripts/serve_docs.ts
 * @description Serve the rendered docs cache using its manifest.
 *
 *   bun run docs:serve                 # http://127.0.0.1:3000
 *   bun run docs:serve --port 8080
 *
 * No filesystem walk at startup: the manifest is the index. It is re-read when its mtime changes,
 * so `bun run docs:render` is picked up without a restart.
 */

import { join } from "node:path";
import {
  flagValue,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import { MANIFEST_FILE } from "../lib/docs_render_cache.ts";
import { createDocsServer } from "../lib/docs_server.ts";

const HELP = `
docs:serve — serve the rendered docs cache from its manifest

Options:
  --port <n>        Listen port (default: 3000)
  --host <name>     Bind address (default: 127.0.0.1)
  --cache <dir>     Rendered cache (default: scratch/.md-cache)
  --manifest <path> Manifest path (default: <cache>/manifest.json)
  -h, --help        This text

Examples:
  bun run docs:serve
  bun run docs:serve --port 8080
  bun run docs:serve --cache scratch/.md-cache --host 0.0.0.0

Routes: /health, /docs, /docs/:key (zstd when the client accepts it).
Generate the cache first with \`bun run docs:render\`.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--port", "--host", "--cache", "--manifest"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const cacheDir = flagValue(parsed, "--cache", "scratch/.md-cache");
const manifestPath = flagValue(
  parsed,
  "--manifest",
  join(cacheDir, MANIFEST_FILE),
);
const port = Number(flagValue(parsed, "--port", "3000"));
const hostname = flagValue(parsed, "--host", "127.0.0.1");

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(
    `docs:serve: invalid --port ${flagValue(parsed, "--port", "")}.`,
  );
  console.error("  bun run docs:serve --port 8080");
  process.exit(2);
}
if (!(await Bun.file(manifestPath).exists())) {
  console.error(`docs:serve: ${manifestPath} is missing.`);
  console.error("  bun run docs:render && bun run docs:serve");
  process.exit(2);
}

const docs = createDocsServer({ cacheDir, manifestPath, port, hostname });
const manifest = await docs.ready();
console.error(
  `docs:serve: http://${docs.server.hostname}:${docs.server.port} · ${manifest ? manifest.buildId.slice(0, 12) : "manifest unavailable"} · ${cacheDir}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void docs.server.stop(true);
    process.exit(0);
  });
}
