#!/usr/bin/env node
/**
 * @file scripts/publish_r2_graph.mjs
 * @description Zero-dependency AWS SigV4 uploader for Cloudflare R2 Object Storage.
 * Publishes `dist/graph.html`, `dist/graph.js`, `dist/graph-live-feed.json`, `dist/index.html`,
 * and `dist/openapi.json` directly to the public Cloudflare R2 edge domain
 * (`https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/graph.html`).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(repoRoot, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const accessKeyId = process.env.R2_ACCESS_KEY_ID || "6811c91e1bbb1542f44889a3ef74af7e";
const secretAccessKey =
  process.env.R2_SECRET_ACCESS_KEY ||
  "776264a6ab9e4ee81e933481fd77a7a21599256fe7252c2708efb8296dce0974";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "7a470541a704caaf91e71efccc78fd36";
const bucket = process.env.R2_BUCKET_NAME || "sportsdesk-ops-reports";
const publicBase =
  process.env.R2_PUBLIC_URL || "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";
const host = `${accountId}.r2.cloudflarestorage.com`;
const region = "auto";
const service = "s3";

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function getSignatureKey(key, dateStamp, regionName, serviceName) {
  const kDate = hmac(`AWS4${key}`, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, "aws4_request");
}

async function putObject(key, bodyBuf, contentType) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(bodyBuf);
  const canonicalUri = `/${bucket}/${key}`;
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${host}${canonicalUri}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization,
    },
    body: bodyBuf,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 PUT ${key} failed (${res.status}): ${text}`);
  }
  return `${publicBase}/${key}`;
}

const filesToPublish = [
  { file: "dist/graph.html", key: "graph.html", type: "text/html; charset=utf-8" },
  { file: "dist/graph.js", key: "graph.js", type: "application/javascript; charset=utf-8" },
  { file: "dist/graph-live-feed.json", key: "graph-live-feed.json", type: "application/json; charset=utf-8" },
  { file: "dist/backtest-4wk-cfb-nba.json", key: "backtest-4wk-cfb-nba.json", type: "application/json; charset=utf-8" },
  { file: "dist/index.html", key: "index.html", type: "text/html; charset=utf-8" },
  { file: "dist/openapi.json", key: "openapi.json", type: "application/json; charset=utf-8" },
];

console.log("================================================================================");
console.log("  ☁️  PUBLISHING SURVEILLANCE GRAPH, LIVE FEED & PORTAL TO CLOUDFLARE R2 EDGE");
console.log("================================================================================");

for (const item of filesToPublish) {
  const fullPath = path.join(repoRoot, item.file);
  if (!fs.existsSync(fullPath)) continue;
  const buf = fs.readFileSync(fullPath);
  const url = await putObject(item.key, buf, item.type);
  console.log(`  ✓ Published ${item.key.padEnd(20)} (${String(buf.length).padStart(6)} B | sha256 ${sha256Hex(buf).slice(0, 12)}…) -> ${url}`);
}

// Verify live HTTP 200 on the public R2 edge URL
const verifyRes = await fetch(`${publicBase}/graph.html`);
const verifyBytes = Buffer.from(await verifyRes.arrayBuffer());
const feedRes = await fetch(`${publicBase}/graph-live-feed.json`);
const feedJson = await feedRes.json();
console.log("--------------------------------------------------------------------------------");
console.log(
  `  🌐 LIVE EDGE VERIFICATION:\n` +
  `    • GET ${publicBase}/graph.html           -> HTTP ${verifyRes.status} (${verifyBytes.length} B, sha256=${sha256Hex(verifyBytes).slice(0, 16)}…)\n` +
  `    • GET ${publicBase}/graph-live-feed.json -> HTTP ${feedRes.status} (Last Updated: ${feedJson.lastUpdatedCdt} | ${feedJson.totalOpenLegsCount} legs)`
);
console.log("================================================================================");
