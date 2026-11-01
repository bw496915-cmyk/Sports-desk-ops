#!/usr/bin/env bun
/**
 * @file scripts/net/record_proxy.ts
 * @description HTTP recording proxy for Bun's own clients.
 *
 *   bun run proxy:record --allow 127.0.0.1
 *   fetch("http://127.0.0.1:8081/path", { proxy: "http://127.0.0.1:8080" })
 *
 * Records method, URL, headers (redacted), request bytes, status, response headers, response bytes and
 * duration. Plain HTTP only: HTTPS through a proxy needs CONNECT tunnelling, which `Bun.serve` does not
 * expose to a fetch handler. Browser traffic never touches this.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../../lib/cli_args.ts";
import { redactHeaders } from "../capture/redact.ts";

const HELP = `
proxy:record — HTTP recording proxy

Options:
  --port <n>        Listen port (default: 8080)
  --allow <hosts>   Comma-separated allowlist (default: 127.0.0.1,localhost)
  --out <dir>       Journal directory (default: scratch/proxy)
  --quiet           Do not print per-request lines
  -h, --help        This text

Examples:
  bun run proxy:record --allow 127.0.0.1
  bun run proxy:record --port 9090 --allow api.example.com

Use it with Bun's fetch: fetch(url, { proxy: "http://127.0.0.1:8080" }). Plain HTTP only, and Bun
bypasses the proxy for loopback targets, so test against a non-loopback host.
`.trim();

const parsed = parseCliArgs(process.argv.slice(2), {
  valueFlags: ["--port", "--allow", "--out"],
});
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const port = Number(flagValue(parsed, "--port", "8080")) || 8080;
const allow = new Set(
  flagValue(parsed, "--allow", "127.0.0.1,localhost")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== ""),
);
const outRoot = flagValue(parsed, "--out", "scratch/proxy");
const quiet = hasFlag(parsed, "--quiet");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const journal = join(outRoot, `${stamp}.jsonl`);
await mkdir(dirname(journal), { recursive: true });

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardable(headers: Headers): Headers {
  const clean = new Headers();
  for (const [name, value] of headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    clean.set(name, value);
  }
  return clean;
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (!allow.has(url.hostname.toLowerCase())) {
      return new Response(
        `proxy: host ${url.hostname} is not in the allowlist`,
        { status: 403 },
      );
    }

    const started = performance.now();
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    const requestHeaders = forwardable(request.headers);

    const upstream = await fetch(url, {
      method: request.method,
      headers: requestHeaders,
      body,
      redirect: "manual",
      // Keep the body encoded so the forwarded content-encoding header stays truthful.
      decompress: false,
    });
    const responseBytes = new Uint8Array(await upstream.arrayBuffer());
    const durationMs = Math.round(performance.now() - started);
    const redaction = redactHeaders(
      Object.fromEntries(
        [...request.headers].map(([name, value]) => [name, value]),
      ),
    );

    const record = {
      at: new Date().toISOString(),
      method: request.method,
      url: url.href,
      status: upstream.status,
      requestBytes: body?.byteLength ?? 0,
      responseBytes: responseBytes.byteLength,
      durationMs,
      requestHeaders: redaction.clean,
      responseHeaders: Object.fromEntries(upstream.headers),
    };
    await appendFile(journal, `${JSON.stringify(record)}\n`, "utf8");
    if (!quiet) {
      console.log(
        `${record.method.padEnd(6)} ${String(record.status).padEnd(4)} ${record.durationMs} ms  ${url.pathname}  ${record.requestBytes}→${record.responseBytes} B`,
      );
    }

    return new Response(responseBytes, {
      status: upstream.status,
      headers: forwardable(upstream.headers),
    });
  },
});

console.error(
  `proxy:record: http://127.0.0.1:${server.port} · allow ${[...allow].join(",")} · journal ${journal}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop(true);
    process.exit(0);
  });
}
