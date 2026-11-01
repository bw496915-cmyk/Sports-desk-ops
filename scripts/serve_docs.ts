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
import { MANIFEST_FILE } from "../lib/docs_render_cache.ts";
import { createDocsServer } from "../lib/docs_server.ts";

function flag(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1]! : fallback;
}

const args = process.argv.slice(2);
const cacheDir = flag(args, "--cache", "scratch/.md-cache");
const manifestPath = flag(args, "--manifest", join(cacheDir, MANIFEST_FILE));
const port = Number(flag(args, "--port", "3000"));
const hostname = flag(args, "--host", "127.0.0.1");

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`docs:serve: invalid --port ${flag(args, "--port", "")}`);
  process.exit(2);
}
if (!(await Bun.file(manifestPath).exists())) {
  console.error(
    `docs:serve: ${manifestPath} is missing; run \`bun run docs:render\` first`,
  );
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
