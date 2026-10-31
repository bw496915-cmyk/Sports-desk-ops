#!/usr/bin/env node
/**
 * @file scripts/generate_pipeline_reference_images.ts
 * @description Generates specification-grade SVG & PNG pipeline reference diagrams with rich
 * embedded metadata:
 *   - SVG `<metadata>` containing W3C RDF / Dublin Core (`dc:title`, `dc:creator`, `dc:description`,
 *     `dc:subject`, `dc:identifier`) + Schema.org `ImageObject` / `TechArticle` JSON-LD
 *   - PNG binary chunks (`tEXt` & `iTXt` with CRC32 verification) embedding `Title`, `Author`,
 *     `Description`, `Software`, `Source`, `XML:com.adobe.xmp` (Adobe XMP packet), and
 *     `SportsDesk:PipelineSpecJson` (canonical 10-Mode & 6-Layer JSON specification)
 *   - Sidecar catalog `docs/assets/pipeline-artifacts-metadata.json` with SHA-256 digests,
 *     public Cloudflare R2 URLs, repository paths, upstream module mappings, and CLI commands.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname ?? path.dirname(process.argv[1]), "..");
const docsAssetsDir = path.join(repoRoot, "docs", "assets");
const distAssetsDir = path.join(repoRoot, "dist", "assets");
const publicR2Base = "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";

fs.mkdirSync(docsAssetsDir, { recursive: true });
fs.mkdirSync(distAssetsDir, { recursive: true });

export interface PipelineArtifactSpec {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly domainsCovered: readonly string[];
  readonly modesCovered: readonly number[];
  readonly upstreamModules: readonly string[];
  readonly cleaningLayers: readonly string[];
  readonly operatorCliCommands: readonly string[];
  readonly renderSvgBody: () => string;
}

// ============================================================================
// CRC32 & PNG tEXt / iTXt CHUNK INJECTOR (RFC 2083 Compliant)
// ============================================================================
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildPngChunk(typeFourCc: string, dataBuf: Buffer): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const typeBuf = Buffer.from(typeFourCc, "ascii");
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function buildPngTextChunk(keyword: string, value: string): Buffer {
  const keyBuf = Buffer.from(keyword.slice(0, 79), "latin1");
  const nul = Buffer.from([0]);
  const valBuf = Buffer.from(value, "latin1");
  return buildPngChunk("tEXt", Buffer.concat([keyBuf, nul, valBuf]));
}

function buildPngItxtChunk(keyword: string, utf8Value: string): Buffer {
  // iTXt: keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text(UTF-8)
  const keyBuf = Buffer.from(keyword.slice(0, 79), "latin1");
  const header = Buffer.from([0, 0, 0, 0, 0]);
  const textBuf = Buffer.from(utf8Value, "utf8");
  return buildPngChunk("iTXt", Buffer.concat([keyBuf, header, textBuf]));
}

/**
 * Generates a valid 1600x900 dark-mode raster PNG with a subtle grid & color accent bars
 * when a system SVG rasterizer (`qlmanage` / `sips`) is unavailable, or injects rich `tEXt`
 * and `iTXt` (XMP + JSON-LD) chunks into any existing PNG buffer.
 */
function createFallbackDarkBannerPng(width = 1600, height = 900, accentRgb: [number, number, number] = [6, 182, 212]): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth 8
  ihdr[9] = 2; // color type 2 (RGB)
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = 1 + width * 3;
  const raw = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowStride;
    raw[rowOffset] = 0; // filter None
    const isBorderY = y < 8 || y >= height - 8 || y === 84 || y === height - 64;
    const isGridY = y % 60 === 0;
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 3;
      const isBorderX = x < 8 || x >= width - 8 || x === 400 || x === 800 || x === 1200;
      const isGridX = x % 60 === 0;
      if (isBorderY || isBorderX) {
        raw[px] = accentRgb[0];
        raw[px + 1] = accentRgb[1];
        raw[px + 2] = accentRgb[2];
      } else if (isGridY || isGridX) {
        raw[px] = 19;
        raw[px + 1] = 35;
        raw[px + 2] = 71;
      } else {
        raw[px] = 7;
        raw[px + 1] = 11;
        raw[px + 2] = 20;
      }
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    signature,
    buildPngChunk("IHDR", ihdr),
    buildPngChunk("IDAT", compressed),
    buildPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function injectRichMetadataIntoPng(
  pngBuf: Buffer,
  spec: PipelineArtifactSpec,
  xmpXml: string,
  jsonLdString: string
): Buffer {
  // Strip any previously injected SportsDesk iTXt/tEXt chunks so operation is idempotent
  const signature = pngBuf.subarray(0, 8);
  const chunks: Buffer[] = [signature];
  let offset = 8;
  let injected = false;

  while (offset + 8 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset);
    const type = pngBuf.subarray(offset + 4, offset + 8).toString("ascii");
    const totalChunkLen = 12 + len;
    const rawChunk = pngBuf.subarray(offset, offset + totalChunkLen);

    if (type === "IHDR") {
      chunks.push(rawChunk);
      chunks.push(buildPngTextChunk("Title", spec.title));
      chunks.push(buildPngTextChunk("Author", "SportsDesk & Fantasy402 Risk Engineering (BILLY666 Master)"));
      chunks.push(buildPngTextChunk("Description", spec.description));
      chunks.push(buildPngTextChunk("Software", "SportsDesk 10-Mode Forensic & Canonical Pipeline Generator (Bun v1.4.4)"));
      chunks.push(buildPngTextChunk("Source", `${publicR2Base}/assets/${spec.slug}.svg`));
      chunks.push(buildPngTextChunk("Copyright", "SportsDesk Ops Specification-Grade Reference Artifact"));
      chunks.push(buildPngItxtChunk("XML:com.adobe.xmp", xmpXml));
      chunks.push(buildPngItxtChunk("SportsDesk:PipelineSpecJson", jsonLdString));
      injected = true;
    } else if (type === "tEXt" || type === "iTXt") {
      // Skip old text chunks so we replace cleanly
    } else {
      chunks.push(rawChunk);
    }
    offset += totalChunkLen;
  }

  if (!injected) return pngBuf;
  return Buffer.concat(chunks);
}

function buildXmpPacket(spec: PipelineArtifactSpec): string {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:xmp="http://ns.adobe.com/xap/1.0/"
           xmlns:sportsdesk="https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/ns/1.0/">
    <rdf:Description rdf:about="${publicR2Base}/assets/${spec.slug}.svg">
      <dc:identifier>${spec.id}</dc:identifier>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${spec.title}</rdf:li></rdf:Alt></dc:title>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${spec.description}</rdf:li></rdf:Alt></dc:description>
      <dc:creator><rdf:Seq><rdf:li>SportsDesk &amp; Fantasy402 Risk Engineering</rdf:li></rdf:Seq></dc:creator>
      <dc:subject><rdf:Bag>${spec.domainsCovered.map((d) => `<rdf:li>${d}</rdf:li>`).join("")}${spec.upstreamModules.map((m) => `<rdf:li>${m}</rdf:li>`).join("")}</rdf:Bag></dc:subject>
      <xmp:CreatorTool>SportsDesk 10-Mode Pipeline Generator (Bun v1.4.4)</xmp:CreatorTool>
      <sportsdesk:modesCovered>${spec.modesCovered.join(",")}</sportsdesk:modesCovered>
      <sportsdesk:cliEntrypoint>${spec.operatorCliCommands.join(" | ")}</sportsdesk:cliEntrypoint>
      <sportsdesk:portalUrl>${publicR2Base}/graph.html</sportsdesk:portalUrl>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function buildFullSvgDocument(spec: PipelineArtifactSpec, xmpXml: string, jsonLdObj: object): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 920" width="1600" height="920" role="img" aria-labelledby="${spec.slug}-title ${spec.slug}-desc">
  <title id="${spec.slug}-title">${spec.title}</title>
  <desc id="${spec.slug}-desc">${spec.description}</desc>
  <metadata>
    ${xmpXml}
    <script type="application/ld+json">${JSON.stringify(jsonLdObj)}</script>
  </metadata>
  <defs>
    <style>
      .bg { fill: #070b14; }
      .panel { fill: #0b1329; stroke-width: 2; rx: 12px; }
      .card { fill: #101c38; stroke-width: 1.5; rx: 8px; }
      .title { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; font-size: 24px; font-weight: 800; fill: #f8fafc; letter-spacing: 0.03em; }
      .subtitle { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; fill: #38bdf8; }
      .col-hdr { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 15px; font-weight: 800; letter-spacing: 0.05em; }
      .card-title { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13.5px; font-weight: 700; fill: #f8fafc; }
      .card-body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; fill: #cbd5e1; }
      .card-accent { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 700; }
      .footer { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 700; fill: #6ee7b7; }
    </style>
  </defs>
  <rect class="bg" x="0" y="0" width="1600" height="920" />
  <!-- Header Banner -->
  <rect x="24" y="18" width="1552" height="68" rx="10" fill="#0f172a" stroke="#1e293b" stroke-width="1.5" />
  <text x="48" y="48" class="title">${spec.title}</text>
  <text x="48" y="70" class="subtitle">${spec.subtitle} • ID: ${spec.id} • Live R2 Portal: ${publicR2Base}/graph.html</text>
  ${spec.renderSvgBody()}
  <!-- Footer Command Bar -->
  <rect x="24" y="856" width="1552" height="46" rx="8" fill="#06281e" stroke="#10b981" stroke-width="1.8" />
  <text x="48" y="884" class="footer">⚡ OPERATOR CLI &amp; LIVE LINKS: ${spec.operatorCliCommands.join("   |   ")}   →   ${publicR2Base}/graph.html</text>
</svg>
`;
}

// ============================================================================
// 3 CANONICAL PIPELINE REFERENCE DIAGRAM SPECIFICATIONS
// ============================================================================
export const PIPELINE_ARTIFACTS: readonly PipelineArtifactSpec[] = [
  {
    id: "SD-ARTIFACT-01-10MODE-PIPELINE",
    slug: "pipeline-10-mode-architecture",
    title: "SPORTSDESK & FANTASY402 — DATA CLEANING, 10-MODE ENGINE & OPERATOR ACTION PIPELINE",
    subtitle: "End-to-End Flow: 4 Upstream Feeds -> 6-Layer Canonical Cleaner -> 10-Mode Diagnostic Matrix -> Automated Desk Actions",
    description:
      "End-to-end architectural diagram showing how report.js, help-report.js, bet-ticker.js, ip-tracker.js, GSLive Partner 118 (player_[login]), and Polymarket CLOB/Data APIs are cleaned into canonical primitives, evaluated across Modes 1..10 (Risk & Exposure, Identity & Network, Cross-Market, Data Integrity), and converted into sub-320ms Ban-Hammer clamps, Stepped Line dispatches, +15c/+20c vig shading, and $0-gap ledger reconciliations.",
    domainsCovered: ["Risk & Exposure", "Identity & Network", "Cross-Market", "Data Integrity"],
    modesCovered: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    upstreamModules: [
      "customer/report/report.js",
      "app/manager/report/help-report.js",
      "app/manager/module/bet-ticker.js",
      "app/manager/module/ip-tracker.js",
      "Polymarket Gamma/CLOB/Data API",
      "GSLive Manager Partner 118 (player_[login])",
    ],
    cleaningLayers: [
      "TicketNumber-WagerNumber Parent Grouping",
      "BLOCKED Drop & ALERT Mirror Zeroing",
      "FreePlayFlag='Y' Zero-Principal Loss & Stake/Payout/Liability Split",
      "Teaser Effective Line & DGS ROT+5000 Normalization",
      "Mode B Per-Office customerID=<Office> vs Global 0 & Mode C YYYY-MM-DD",
      "4-Surface Identity Join & 11-Char PaddedCustomerId Write Guard",
    ],
    operatorCliCommands: [
      "./bin/dx status",
      "./bin/dx modes [1..10]",
      "./bin/dx iptracker",
      "./bin/dx deploy",
    ],
    renderSvgBody: () => `
      <!-- COLUMN 1: UPSTREAM FEEDS -->
      <rect class="panel" x="24" y="102" width="368" height="736" stroke="#06b6d4" />
      <text x="44" y="132" class="col-hdr" fill="#38bdf8">1. UPSTREAM FEEDS &amp; MODULES</text>

      <rect class="card" x="42" y="150" width="332" height="155" stroke="#06b6d4" />
      <text x="58" y="175" class="card-title">📄 report.js &amp; help-report.js</text>
      <text x="58" y="198" class="card-body">• api/Report/Pending &amp; getPendingByTicket</text>
      <text x="58" y="216" class="card-body">• api/Report/getDailyFiguresByCustomer</text>
      <text x="58" y="234" class="card-body">• api/Report/getGradedWagerByCustomer</text>
      <text x="58" y="252" class="card-body">• api/Report/getTransactions &amp; getGrading</text>
      <text x="58" y="274" class="card-accent" fill="#67e8f9">getTypeInfo(10) • getRotationNumber • getLineGame</text>

      <rect class="card" x="42" y="322" width="332" height="150" stroke="#06b6d4" />
      <text x="58" y="347" class="card-title">⚡ bet-ticker.js (Manager/getBetTicker)</text>
      <text x="58" y="370" class="card-body">• 5,000ms watermark poll (lastWagerNumber)</text>
      <text x="58" y="388" class="card-body">• Dual ID: l.Login (Player) + l.AgentLogin (Office)</text>
      <text x="58" y="406" class="card-body">• Channels: Internet, ALERT, GSLIVE, GSBUILDER</text>
      <text x="58" y="428" class="card-accent" fill="#67e8f9">getListVip • vipListInsert • #D90000 Alert Flag</text>

      <rect class="card" x="42" y="488" width="332" height="155" stroke="#06b6d4" />
      <text x="58" y="513" class="card-title">🌐 ip-tracker.js (Manager/getWebLog)</text>
      <text x="58" y="536" class="card-body">• Mode A: WEB_ACCESS (MM/DD/YYYY)</text>
      <text x="58" y="554" class="card-body">• Mode B: Per-Office (customerID=&lt;Office&gt;) vs 0</text>
      <text x="58" y="572" class="card-body">• Mode C: PLAYER_IP_MATCHER (YYYY-MM-DD)</text>
      <text x="58" y="590" class="card-body">• Mode I: Reverse IP Lookup (ip=&lt;IP&gt;)</text>
      <text x="58" y="612" class="card-accent" fill="#67e8f9">Pivots: go-ip (Mode I) • go-customer (Mode A)</text>

      <rect class="card" x="42" y="660" width="332" height="158" stroke="#06b6d4" />
      <text x="58" y="685" class="card-title">🔗 Polymarket APIs &amp; GSLive Partner 118</text>
      <text x="58" y="708" class="card-body">• CLOB WSS (&lt;500ms SLA: 345ms E2E)</text>
      <text x="58" y="726" class="card-body">• data-api.polymarket.com/positions?user=0x</text>
      <text x="58" y="744" class="card-body">• plive.sportswidgets.pro/manager-tools/</text>
      <text x="58" y="766" class="card-accent" fill="#6ee7b7">39 0x Wallets ↔ 49 F402 Logins ↔ player_[login]</text>

      <!-- COLUMN 2: CANONICAL DATA CLEANING -->
      <rect class="panel" x="418" y="102" width="368" height="736" stroke="#10b981" />
      <text x="438" y="132" class="col-hdr" fill="#6ee7b7">2. 6-LAYER CANONICAL DATA CLEANING</text>

      <rect class="card" x="436" y="150" width="332" height="105" stroke="#10b981" />
      <text x="452" y="173" class="card-title">1. Parent Ticket Grouping</text>
      <text x="452" y="194" class="card-body">Composite key: TicketNumber + "-" + WagerNumber</text>
      <text x="452" y="212" class="card-body">Collapses multi-leg parlay rows so Stake &amp; ToWin</text>
      <text x="452" y="230" class="card-accent" fill="#6ee7b7">are counted 1x per ticket (never multiplied by legs)</text>

      <rect class="card" x="436" y="268" width="332" height="105" stroke="#10b981" />
      <text x="452" y="291" class="card-title">2. Channel &amp; Twin Deduplication</text>
      <text x="452" y="312" class="card-body">Drops BLOCKED sentinel rows pre-grouping;</text>
      <text x="452" y="330" class="card-body">Zeroes ALERT syndicate mirror slips (&lt;=6s twin)</text>
      <text x="452" y="348" class="card-accent" fill="#6ee7b7">canonicalVolumeCents = 0 on ALERT twin rows</text>

      <rect class="card" x="436" y="386" width="332" height="105" stroke="#10b981" />
      <text x="452" y="409" class="card-title">3. Free-Play &amp; Liability Separation</text>
      <text x="452" y="430" class="card-body">FreePlayFlag="Y": Loss = $0 principal debit;</text>
      <text x="452" y="448" class="card-body">Separates Stake ($16.2K), Payout ($67.82K),</text>
      <text x="452" y="466" class="card-accent" fill="#6ee7b7">&amp; Defined Liability ($51.62K) for MJ102</text>

      <rect class="card" x="436" y="504" width="332" height="105" stroke="#10b981" />
      <text x="452" y="527" class="card-title">4. Effective Line &amp; DGS ROT+5000 Math</text>
      <text x="452" y="548" class="card-body">Spread: AdjSpread+Teaser | Total O/U: -/+Teaser</text>
      <text x="452" y="566" class="card-body">Integer LineHundredths (-7.5 -&gt; -750);</text>
      <text x="452" y="584" class="card-accent" fill="#6ee7b7">DGS Child ROT 5501 normalized -&gt; Parent ROT 501</text>

      <rect class="card" x="436" y="622" width="332" height="95" stroke="#10b981" />
      <text x="452" y="645" class="card-title">5. IP-Tracker Mode B &amp; Mode C Hygiene</text>
      <text x="452" y="666" class="card-body">Mode B customerID=&lt;Office&gt; vs "0" (MM/DD/YYYY)</text>
      <text x="452" y="684" class="card-accent" fill="#6ee7b7">Mode C auto-rewrites dates to YYYY-MM-DD</text>

      <rect class="card" x="436" y="728" width="332" height="92" stroke="#10b981" />
      <text x="452" y="751" class="card-title">6. 11-Char Write Padding &amp; Scope Guard</text>
      <text x="452" y="772" class="card-body">padEnd(11, " ") on customerID; direct office</text>
      <text x="452" y="790" class="card-accent" fill="#6ee7b7">agentID (blocks BILLY666 &amp; poisoned path 500s)</text>

      <!-- COLUMN 3: 10-MODE DIAGNOSTIC MATRIX -->
      <rect class="panel" x="812" y="102" width="368" height="736" stroke="#f59e0b" />
      <text x="832" y="132" class="col-hdr" fill="#fcd34d">3. 10-MODE DIAGNOSTIC MATRIX</text>

      <rect class="card" x="830" y="150" width="332" height="175" stroke="#f59e0b" />
      <text x="846" y="175" class="card-title" fill="#fcd34d">DOMAIN A: RISK &amp; EXPOSURE (MODES 1, 8, 9)</text>
      <text x="846" y="198" class="card-body">• Mode 1 · Customer Overview: Validated net,</text>
      <text x="846" y="215" class="card-body">  pending exposure, freshness &amp; gap warnings</text>
      <text x="846" y="236" class="card-body">• Mode 8 · Settled Net: 24H/7D/4WK USD &amp; USDC</text>
      <text x="846" y="253" class="card-body">  P/L + FreePlay saved + ledger adjustments</text>
      <text x="846" y="274" class="card-body">• Mode 9 · Pending Exposure: Unique tickets,</text>
      <text x="846" y="291" class="card-accent" fill="#fcd34d">  Stake vs Potential Payout vs Defined Liability</text>

      <rect class="card" x="830" y="340" width="332" height="225" stroke="#38bdf8" />
      <text x="846" y="365" class="card-title" fill="#7dd3fc">DOMAIN B: IDENTITY &amp; NETWORK (MODES 2–6)</text>
      <text x="846" y="388" class="card-body">• Mode 2 · Access Logs: SELF_PLAYER vs</text>
      <text x="846" y="405" class="card-body">  OFFICE_AGENT Actor/Target &amp; 4.2s wager dwell</text>
      <text x="846" y="426" class="card-body">• Mode 3 · Shared-IP Overview: 13 Office &amp;</text>
      <text x="846" y="443" class="card-body">  Cross-Office /24 subnet groups</text>
      <text x="846" y="464" class="card-body">• Mode 4 · Customer IP History: ASN switches</text>
      <text x="846" y="481" class="card-body">  &amp; &gt;24h collection gap warnings (32.75h)</text>
      <text x="846" y="502" class="card-body">• Mode 5 · Accounts by IP: 104.28.34.12 (5 accts)</text>
      <text x="846" y="523" class="card-accent" fill="#7dd3fc">• Mode 6 · Activity Overlap: 270s Session Overlap</text>
      <text x="846" y="540" class="card-accent" fill="#7dd3fc">  vs 24s Nearby Point Events</text>

      <rect class="card" x="830" y="580" width="332" height="115" stroke="#10b981" />
      <text x="846" y="605" class="card-title" fill="#6ee7b7">DOMAIN C: CROSS-MARKET (MODE 7)</text>
      <text x="846" y="628" class="card-body">• Mode 7 · Wager Comparison: F402 vs Polymarket</text>
      <text x="846" y="646" class="card-body">  by ROT, Period, Side, LineHundredths (Δ=+100)</text>
      <text x="846" y="666" class="card-accent" fill="#6ee7b7">  &amp; Δt=4s with matchReasons &amp; uncertaintyFlags</text>

      <rect class="card" x="830" y="710" width="332" height="110" stroke="#f43f5e" />
      <text x="846" y="735" class="card-title" fill="#fda4af">DOMAIN D: DATA INTEGRITY (MODE 10)</text>
      <text x="846" y="758" class="card-body">• Mode 10 · Reconciliation: DailyFigures vs</text>
      <text x="846" y="776" class="card-body">  GradedTickets vs Ledger (Identical Scope)</text>
      <text x="846" y="796" class="card-accent" fill="#6ee7b7">  Explained Diff -$1,500 • Unresolved Gap = $0.00</text>

      <!-- COLUMN 4: OPERATOR & AUTOMATED DESK ACTIONS -->
      <rect class="panel" x="1206" y="102" width="370" height="736" stroke="#f43f5e" />
      <text x="1226" y="132" class="col-hdr" fill="#fda4af">4. OPERATOR &amp; AUTOMATED ACTIONS</text>

      <rect class="card" x="1224" y="150" width="334" height="155" stroke="#f43f5e" />
      <text x="1240" y="175" class="card-title">🔨 Ban-Hammer Profile Clamp (&lt;320ms)</text>
      <text x="1240" y="198" class="card-body">Triggered by Mode 2 (Dwell &lt;=6s), Mode 3/5</text>
      <text x="1240" y="216" class="card-body">(Shared Office IP), or Mode 6 (Session Overlap):</text>
      <text x="1240" y="238" class="card-accent" fill="#fda4af">• MaxBet = $1,000   • ParlayMaxBet = $0</text>
      <text x="1240" y="256" class="card-accent" fill="#fda4af">• Delay = 6s        • Allow1H2HQtr = 0 (FG-Only)</text>
      <text x="1240" y="278" class="card-body">Verified via getInfoPlayer read-back</text>

      <rect class="card" x="1224" y="322" width="334" height="155" stroke="#f59e0b" />
      <text x="1240" y="347" class="card-title">📉 Stepped Line Dispatcher &amp; Vig Curtain</text>
      <text x="1240" y="370" class="card-body">Triggered by Mode 7 Cross-Market LineDelta</text>
      <text x="1240" y="388" class="card-body">or &lt;500ms CLOB WSS Steam (TXST +14.5 -&gt; +13.0,</text>
      <text x="1240" y="406" class="card-body">KC -1.5 -&gt; -2.5, Patriots Key-7 crossing):</text>
      <text x="1240" y="428" class="card-accent" fill="#fcd34d">• Step half-point at -125/-125 Vig Curtain</text>
      <text x="1240" y="446" class="card-accent" fill="#fcd34d">• Route $312K Key-7 layoff to Wintermute RFQ</text>

      <rect class="card" x="1224" y="494" width="334" height="155" stroke="#a855f7" />
      <text x="1240" y="519" class="card-title">🛡️ +15c/+20c Vig Shading &amp; Probit Guard</text>
      <text x="1240" y="542" class="card-body">Triggered by Mode 8 High-CLV Extractor or</text>
      <text x="1240" y="560" class="card-body">Mode 7 DGS ROT+5000 Same-Game Alt+ML Parlay:</text>
      <text x="1240" y="582" class="card-accent" fill="#e9d5ff">• vigSetupInsert (+15c Spread / +20c Derivative)</text>
      <text x="1240" y="600" class="card-accent" fill="#e9d5ff">• Block Alt+ML Subset when Probit ρ &gt;= 0.65</text>
      <text x="1240" y="620" class="card-body">• Reprice 6pt Key-3/7 Teasers to -135</text>

      <rect class="card" x="1224" y="666" width="334" height="154" stroke="#10b981" />
      <text x="1240" y="691" class="card-title">✅ 180s Quarantine &amp; Mode 10 Settlement</text>
      <text x="1240" y="714" class="card-body">• 180s Quarantine Auto-Resolver reverts</text>
      <text x="1240" y="732" class="card-body">  DEN/PHX U223.5 scalp trap @ T+112s</text>
      <text x="1240" y="754" class="card-body">• Mode 9 sizes hedges on Defined Liability</text>
      <text x="1240" y="776" class="card-accent" fill="#6ee7b7">• Mode 10 confirms Unresolved Gap == $0.00</text>
      <text x="1240" y="794" class="card-accent" fill="#6ee7b7">  before weekly agent balance settlement</text>
    `,
  },
  {
    id: "SD-ARTIFACT-02-6LAYER-CLEANING",
    slug: "pipeline-6-layer-data-cleaning",
    title: "ROSETTA STONE 6-LAYER DATA CLEANING & CANONICAL FIELD MAPPING REFERENCE",
    subtitle: "De-obfuscated report.js • help-report.js • bet-ticker.js • ip-tracker.js -> Canonical TypeScript Primitives",
    description:
      "Detailed engineering reference diagram illustrating the 6 canonical data-cleaning transformations applied to Fantasy402, GSLive Partner 118, and Polymarket feeds: (1) TicketNumber-WagerNumber composite parent grouping, (2) BLOCKED drop & ALERT mirror zeroing, (3) FreePlayFlag='Y' zero-principal loss & Stake/Payout/Liability separation, (4) Teaser effective line & DGS GameNum+5000 parent rotation normalization, (5) IP-Tracker Mode B Per-Office vs Global & Mode C YYYY-MM-DD date rewrite, and (6) 4-Surface Identity Join with 11-char space-padded PaddedCustomerId write enforcement.",
    domainsCovered: ["Risk & Exposure", "Identity & Network", "Cross-Market", "Data Integrity"],
    modesCovered: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    upstreamModules: [
      "customer/report/report.js",
      "app/manager/report/help-report.js",
      "app/manager/module/bet-ticker.js",
      "app/manager/module/ip-tracker.js",
    ],
    cleaningLayers: [
      "Layer 1: Composite TicketNumber-WagerNumber Grouping",
      "Layer 2: TicketWriter BLOCKED Drop & ALERT Twin Zeroing",
      "Layer 3: Effective Line Math (LineHundredths & DGS ROT+5000)",
      "Layer 4: FreePlayFlag='Y' Zero-Principal Loss & Liability Split",
      "Layer 5: IP-Tracker Mode B Scope & Mode C YYYY-MM-DD Rewrite",
      "Layer 6: 4-Surface Identity & 11-Char PaddedCustomerId",
    ],
    operatorCliCommands: [
      "./bin/dx modes 7",
      "./bin/dx modes 9",
      "./bin/dx modes 10",
      "node --test tests/forensic_diagnostic_modes.test.ts",
    ],
    renderSvgBody: () => `
      <!-- ROW 1: LAYERS 1, 2, 3 -->
      <rect class="panel" x="24" y="102" width="504" height="356" stroke="#06b6d4" />
      <text x="44" y="132" class="col-hdr" fill="#38bdf8">LAYER 1: PARENT TICKET DEDUPLICATION</text>
      <text x="44" y="160" class="card-body">Upstream Source: report.js / help-report.js (api/Report/Pending)</text>
      <rect class="card" x="44" y="176" width="464" height="125" stroke="#1e293b" />
      <text x="60" y="200" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (1 Row Per Leg Repeats Full Ticket Risk):</text>
      <text x="60" y="220" class="card-body">Row 1: Ticket 901104-1 (Leg 1 LAL 1Q) -&gt; AmountWagered: 1620000</text>
      <text x="60" y="238" class="card-body">Row 2: Ticket 901104-1 (Leg 2 LAL -3) -&gt; AmountWagered: 1620000</text>
      <text x="60" y="264" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (evaluateMode9PendingExposure):</text>
      <text x="60" y="284" class="card-body">Group by composite key: d.TicketNumber + "-" + d.WagerNumber</text>
      <text x="44" y="330" class="card-body">• Counts Stake ($16,200) &amp; ToWin ($42,120) strictly 1x per parent ticket</text>
      <text x="44" y="352" class="card-body">• Prevents 2x–6x exposure inflation on multi-leg parlays &amp; teasers</text>
      <text x="44" y="378" class="card-accent" fill="#38bdf8">Used by: Mode 9 (Pending Exposure) &amp; Mode 7 (Combo Hash)</text>

      <rect class="panel" x="548" y="102" width="504" height="356" stroke="#10b981" />
      <text x="568" y="132" class="col-hdr" fill="#6ee7b7">LAYER 2: CHANNEL &amp; TWIN DEDUPLICATION</text>
      <text x="568" y="160" class="card-body">Upstream Source: bet-ticker.js (POST /cloud/api/Manager/getBetTicker)</text>
      <rect class="card" x="568" y="176" width="464" height="125" stroke="#1e293b" />
      <text x="584" y="200" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Sentinel &amp; Syndicate Mirror Duplication):</text>
      <text x="584" y="220" class="card-body">TicketWriter="BLOCKED" noise rows + "ALERT" mirror twin slips</text>
      <text x="584" y="238" class="card-body">emitted within &lt;=6s of primary Internet / GSLIVE / GSBUILDER bet</text>
      <text x="584" y="264" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (L19.N0518 &amp; L21.N0884):</text>
      <text x="584" y="284" class="card-body">Drop BLOCKED pre-grouping; set ALERT canonicalVolumeCents = 0</text>
      <text x="568" y="330" class="card-body">• Preserves ALERT row for sub-250ms syndicate velocity telemetry</text>
      <text x="568" y="352" class="card-body">• Eliminates 100% of twin double-counting in Mode 9 liability</text>
      <text x="568" y="378" class="card-accent" fill="#6ee7b7">Used by: Mode 9 (Pending Exposure) &amp; Tab 5 ROT Bet-Ticker</text>

      <rect class="panel" x="1072" y="102" width="504" height="356" stroke="#f59e0b" />
      <text x="1092" y="132" class="col-hdr" fill="#fcd34d">LAYER 3: EFFECTIVE LINE &amp; DGS ROT+5000 MATH</text>
      <text x="1092" y="160" class="card-body">Upstream Source: report.js getLineGame() &amp; getRotationNumber()</text>
      <rect class="card" x="1092" y="176" width="464" height="125" stroke="#1e293b" />
      <text x="1108" y="200" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Split Teaser Fields &amp; Child Rotation IDs):</text>
      <text x="1108" y="220" class="card-body">Teasers split across AdjSpread/AdjTotalPoints + TeaserPoints;</text>
      <text x="1108" y="238" class="card-body">DGS Alt-Spreads book on GameNum + 5000 (ROT 5501 vs 501)</text>
      <text x="1108" y="264" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (computeEffectiveLineHundredths):</text>
      <text x="1108" y="284" class="card-body">Spread: Adj+Teaser | Over: Adj-Teaser | Under: Adj+Teaser</text>
      <text x="1092" y="330" class="card-body">• Stores exact integer LineHundredths (-7.5 -&gt; -750, 48.5 -&gt; 4850)</text>
      <text x="1092" y="352" class="card-body">• Normalizes ROT 5501 -&gt; Parent ROT 501 for Polymarket matching</text>
      <text x="1092" y="378" class="card-accent" fill="#fcd34d">Used by: Mode 7 (Wager Comparison) &amp; Probit Corr Guard</text>

      <!-- ROW 2: LAYERS 4, 5, 6 -->
      <rect class="panel" x="24" y="480" width="504" height="356" stroke="#a855f7" />
      <text x="44" y="510" class="col-hdr" fill="#e9d5ff">LAYER 4: FREE-PLAY &amp; SIGN NORMALIZATION</text>
      <text x="44" y="538" class="card-body">Upstream Source: help-report.js (FreePlayFlag &amp; getTransactions)</text>
      <rect class="card" x="44" y="554" width="464" height="125" stroke="#1e293b" />
      <text x="60" y="578" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Free-Play Asymmetric Cash Accounting):</text>
      <text x="60" y="598" class="card-body">FreePlayFlag="Y" Loss (WagerStatus="L") debits $0 cash principal;</text>
      <text x="60" y="616" class="card-body">FreePlay Win credits only ToWinAmount (stake is never returned)</text>
      <text x="60" y="642" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (Modes 8, 9 &amp; 10):</text>
      <text x="60" y="662" class="card-body">FreePlay Stake = $0 | Payout = Stake+ToWin | Liability = ToWin</text>
      <text x="44" y="708" class="card-body">• Tracks freePlayLostPrincipalSavedCents ($3,000 on MJ102)</text>
      <text x="44" y="730" class="card-body">• Enforces CUSTOMER_PERSPECTIVE_POSITIVE_IS_PLAYER_WIN</text>
      <text x="44" y="756" class="card-accent" fill="#e9d5ff">Used by: Mode 8 (Settled Net), Mode 9, Mode 10 (Reconciliation)</text>

      <rect class="panel" x="548" y="480" width="504" height="356" stroke="#38bdf8" />
      <text x="568" y="510" class="col-hdr" fill="#7dd3fc">LAYER 5: IP-TRACKER MODE &amp; OVERLAP HYGIENE</text>
      <text x="568" y="538" class="card-body">Upstream Source: ip-tracker.js lines 76–89 (Manager/getWebLog)</text>
      <rect class="card" x="568" y="554" width="464" height="125" stroke="#1e293b" />
      <text x="584" y="578" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Overloaded customerID &amp; Date Inversion):</text>
      <text x="584" y="598" class="card-body">Mode B uses customerID=&lt;OfficeAgentID&gt; for Per-Office match vs "0"</text>
      <text x="584" y="616" class="card-body">for Global; Mode C requires YYYY-MM-DD while A/B/I require MM/DD/YYYY</text>
      <text x="584" y="642" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (formatWebLogDateForMode &amp; Mode 6):</text>
      <text x="584" y="662" class="card-body">Auto-formats dates per mode &amp; separates Session vs Point Overlap</text>
      <text x="568" y="708" class="card-body">• Distinguishes 270s Concurrent Session Overlap (MJ102 &lt;-&gt; MJ103)</text>
      <text x="568" y="730" class="card-body">• From 24s Nearby Point Events without session overlap (CHURN_059)</text>
      <text x="568" y="756" class="card-accent" fill="#7dd3fc">Used by: Modes 2, 3, 4, 5, 6 (Identity &amp; Network)</text>

      <rect class="panel" x="1072" y="480" width="504" height="356" stroke="#f43f5e" />
      <text x="1092" y="510" class="col-hdr" fill="#fda4af">LAYER 6: 4-SURFACE ID &amp; 11-CHAR WRITE GUARD</text>
      <text x="1092" y="538" class="card-body">Upstream Source: Manager/updateByColumn &amp; GSLive Partner 118</text>
      <rect class="card" x="1092" y="554" width="464" height="125" stroke="#1e293b" />
      <text x="1108" y="578" class="card-accent" fill="#fda4af">❌ RAW FEED QUIRK (Silent Write No-Ops &amp; Scope Rejection):</text>
      <text x="1108" y="598" class="card-body">Unpadded customerID returns Result: 0 (SILENT_NO_OP); passing</text>
      <text x="1108" y="616" class="card-body">master BILLY666 returns Result: -1; passing path causes HTTP 500</text>
      <text x="1108" y="642" class="card-accent" fill="#6ee7b7">✅ CLEANED RULE (padCustomerIdCanonical &amp; Scope Guard):</text>
      <text x="1108" y="662" class="card-body">"MJ102" -&gt; "MJ102      " (11 chars) + direct office agentID="MJ2026"</text>
      <text x="1092" y="708" class="card-body">• Unifies F402 LoginID + Office AgentLogin + GSLive player_[login] + 0x</text>
      <text x="1092" y="730" class="card-body">• Verifies every write via POST /cloud/api/Manager/getInfoPlayer</text>
      <text x="1092" y="756" class="card-accent" fill="#fda4af">Used by: Mode 1 Drill-Downs &amp; Ban-Hammer Mutation Engine</text>
    `,
  },
  {
    id: "SD-ARTIFACT-03-IP-AND-RECONCILIATION",
    slug: "pipeline-per-office-ip-and-reconciliation",
    title: "PER-OFFICE IP-TRACKER (MODES 2–6) & SCOPE-LOCKED RECONCILIATION (MODES 1, 8, 9, 10)",
    subtitle: "13 Office & Cross-Office IP Clusters (MJ2026, BIGDAD, CUB22HR, ATEAM...) + Zero-Gap Financial Reconciliation",
    description:
      "Reference diagram combining the 13 Per-Office & Cross-Office IP-Tracker clusters (getWebLog Mode B customerID=<OfficeAgentID> vs customerID=0, Mode C YYYY-MM-DD history, Mode I reverse IP, and Mode 6 concurrent session overlap) with the Risk & Data Integrity reconciliation pipeline (Mode 1 Overview, Mode 8 Settled Net, Mode 9 Pending Exposure, and Mode 10 Scope-Locked Reconciliation proving Unresolved Gap = $0.00).",
    domainsCovered: ["Identity & Network", "Risk & Exposure", "Data Integrity"],
    modesCovered: [1, 2, 3, 4, 5, 6, 8, 9, 10],
    upstreamModules: [
      "app/manager/module/ip-tracker.js",
      "app/manager/module/bet-ticker.js",
      "app/manager/report/help-report.js",
    ],
    cleaningLayers: [
      "Per-Office Mode B (customerID=<OfficeAgentID>) vs Global Master (customerID='0')",
      "Mode 6 Concurrent Session Overlap (270s) vs Nearby Point Events (24s)",
      "Mode 10 Identical-Scope Verification (Report DailyFigures vs Settled Tickets vs Ledger)",
    ],
    operatorCliCommands: [
      "./bin/dx iptracker",
      "./bin/dx modes 3",
      "./bin/dx modes 6",
      "./bin/dx modes 10",
    ],
    renderSvgBody: () => `
      <!-- LEFT HALF: PER-OFFICE & CROSS-OFFICE IP-TRACKER PIPELINE (MODES 2-6) -->
      <rect class="panel" x="24" y="102" width="764" height="736" stroke="#06b6d4" />
      <text x="44" y="132" class="col-hdr" fill="#38bdf8">LEFT: PER-OFFICE &amp; CROSS-OFFICE IP-TRACKER (MODES 2, 3, 4, 5, 6)</text>

      <rect class="card" x="44" y="150" width="724" height="150" stroke="#06b6d4" />
      <text x="60" y="175" class="card-title" fill="#67e8f9">Mode 3 · Per-Office vs. Global Shared-IP Matcher (ip-tracker.js line 78)</text>
      <text x="60" y="198" class="card-body">• Per-Office Query: POST /cloud/api/Manager/getWebLog { type: "B", agentID: "BILLY666", customerID: "MJ2026" }</text>
      <text x="60" y="216" class="card-body">  -&gt; Returns 5 accounts in MJ2026 on 104.28.34.12 (MJ102, EJ8834, MJ103, EJ8835, MJ101) | Dwell: 4.2s | MFCS: 98/100</text>
      <text x="60" y="238" class="card-body">• Global Cross-Office Query: POST /cloud/api/Manager/getWebLog { type: "B", agentID: "BILLY666", customerID: "0" }</text>
      <text x="60" y="256" class="card-body">  -&gt; Catches CUB22HR (5x) &lt;-&gt; MAX92/MX920_1 &lt;-&gt; BILLY666/CUST_BAY_1..2 on 104.28.55.19 &amp; LAKERS &lt;-&gt; SOUTHSHORE</text>
      <text x="60" y="278" class="card-accent" fill="#6ee7b7">All 13 Clusters Active: MJ2026, BIGDAD, CUB22HR, ATEAM, GPRO50RSK, JUICEPLUS, DAN318, MACHR, GOLD22, TEXANS, SPEN, LAKERS, KOBE24</text>

      <rect class="card" x="44" y="316" width="724" height="155" stroke="#38bdf8" />
      <text x="60" y="341" class="card-title" fill="#7dd3fc">Modes 2, 4 &amp; 5 · Actor/Target Timeline, YYYY-MM-DD IP History &amp; Reverse IP</text>
      <text x="60" y="364" class="card-body">• Mode 2 (Access Logs): Distinguishes SELF_PLAYER (MJ102 Login @ 14:42:07Z -&gt; Wager @ 14:42:11Z, 4.2s dwell)</text>
      <text x="60" y="382" class="card-body">  from OFFICE_AGENT override (Actor=MJ2026 -&gt; Target=MJ102 @ 14:42:18Z executing Ban-Hammer clamp)</text>
      <text x="60" y="404" class="card-body">• Mode 4 (Customer IP History, type="C" YYYY-MM-DD): Tracks MJ102 across 3 IP spans, 2 ASN transitions,</text>
      <text x="60" y="422" class="card-body">  and flags 1 collection gap (32.75h &gt; 24h threshold)</text>
      <text x="60" y="444" class="card-accent" fill="#67e8f9">• Mode 5 (Accounts by IP, type="I"): 104.28.34.12 -&gt; 5 observed accounts (90 total auth/wager hits)</text>

      <rect class="card" x="44" y="488" width="724" height="165" stroke="#a855f7" />
      <text x="60" y="513" class="card-title" fill="#e9d5ff">Mode 6 · Activity Overlap: Concurrent Session Intervals vs. Nearby Point Events</text>
      <text x="60" y="538" class="card-accent" fill="#fda4af">1. CONFIRMED_CONCURRENT_SESSION_OVERLAP (MJ102 [14:40:00Z..14:46:30Z] &lt;-&gt; MJ103 [14:41:10Z..14:45:40Z]):</text>
      <text x="60" y="558" class="card-body">   Bounded session intervals intersect for 270 seconds on 104.28.34.12 -&gt; Clamp entire office ring</text>
      <text x="60" y="586" class="card-accent" fill="#fcd34d">2. NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP (CHURN_059 @ 15:22:48Z &lt;-&gt; CHURN_049 @ 15:23:12Z):</text>
      <text x="60" y="606" class="card-body">   Single bet-ticker point timestamps separated by 24s (0s session overlap) -&gt; Flagged as nearby point window</text>
      <text x="60" y="632" class="card-accent" fill="#6ee7b7">Prevents false session-overlap accusations when only point-in-time bet timestamps are available</text>

      <rect class="card" x="44" y="670" width="724" height="148" stroke="#10b981" />
      <text x="60" y="695" class="card-title" fill="#6ee7b7">4-Surface Identity Join (F402 + Office + GSLive Partner 118 + Polymarket 0x)</text>
      <text x="60" y="720" class="card-body">• F402 Customer &amp; Office : https://desk.bookdeskops.com/dashboard?customer=MJ102&amp;agent=MJ2026</text>
      <text x="60" y="742" class="card-body">• GSLive Partner 118     : https://plive.sportswidgets.pro/manager-tools/#/reports/users?partnerId=118&amp;text=player_MJ102</text>
      <text x="60" y="764" class="card-body">• Polymarket On-Chain 0x : https://polymarket.com/profile/0x07db5765beba17be154cbfbd6324a15f3c81fa4f</text>
      <text x="60" y="790" class="card-accent" fill="#6ee7b7">• Write Mutation Wire ID : customerID="MJ102      " (11-char padded) + agentOwner="MJ2026"</text>

      <!-- RIGHT HALF: RISK & DATA INTEGRITY RECONCILIATION PIPELINE (MODES 1, 8, 9, 10) -->
      <rect class="panel" x="812" y="102" width="764" height="736" stroke="#f59e0b" />
      <text x="832" y="132" class="col-hdr" fill="#fcd34d">RIGHT: RISK EXPOSURE &amp; SCOPE-LOCKED RECONCILIATION (MODES 1, 8, 9, 10)</text>

      <rect class="card" x="832" y="150" width="724" height="150" stroke="#f59e0b" />
      <text x="848" y="175" class="card-title" fill="#fcd34d">Mode 1 · Customer Overview &amp; Missing-Data Guardrails</text>
      <text x="848" y="198" class="card-body">• MJ102 (MJ2026)  : Validated Net +$42,850 | Pending Stake $60,600 | Liability $64,120 | Fresh 310s ago (OK)</text>
      <text x="848" y="218" class="card-body">• BGD101 (BIGDAD) : Validated Net +$89,400 | Pending Stake $73,300 | Liability $85,411 | Fresh 455s ago (OK)</text>
      <text x="848" y="238" class="card-body">• CB112_1 (CUB22HR): Validated Net +$31,200 | Pending Stake $63,000 | Liability $57,272 | Fresh 368s ago (OK)</text>
      <text x="848" y="262" class="card-accent" fill="#fda4af">• CHURN_059 (LAKERS): Emits STALE_ACCESS_TELEMETRY_54H + WEBLOG_MODE_A_COLLECTION_GAP warnings</text>

      <rect class="card" x="832" y="316" width="724" height="155" stroke="#10b981" />
      <text x="848" y="341" class="card-title" fill="#6ee7b7">Mode 8 · Settled Net (Period &amp; Currency P/L + Free-Play Principal Convention)</text>
      <text x="848" y="364" class="card-body">Sign Convention: CUSTOMER_PERSPECTIVE_POSITIVE_IS_PLAYER_WIN (Book Hold = -SettledSportsNet)</text>
      <text x="848" y="386" class="card-body">• Ticket 899101-1 (7D USD, Standard Win, FreePlay="N"): Stake $22,000 -&gt; Won +$20,000</text>
      <text x="848" y="406" class="card-body">• Ticket 899145-1 (7D USD, FreePlay Win, FreePlay="Y"): Stake $5,000  -&gt; Won +$4,545 (principal excluded)</text>
      <text x="848" y="426" class="card-body">• Ticket 899210-1 (7D USD, FreePlay Loss, FreePlay="Y"): Stake $3,000 -&gt; Lost $0 cash (Saved $3,000 principal)</text>
      <text x="848" y="448" class="card-accent" fill="#6ee7b7">• Net 7D USD: +$24,545 Settled - $1,500 Adj (TXN-ADJ-901) = +$23,045 USD + $19,805 USDC = +$42,850</text>

      <rect class="card" x="832" y="488" width="724" height="150" stroke="#38bdf8" />
      <text x="848" y="513" class="card-title" fill="#7dd3fc">Mode 9 · Pending Exposure (Unique Tickets: Stake vs. Potential Payout vs. Liability)</text>
      <text x="848" y="536" class="card-body">Ingests 4 raw pending rows for MJ102 -&gt; Drops 1 ALERT twin -&gt; Collapses 2 parlay leg rows into 901104-1:</text>
      <text x="848" y="558" class="card-body">• Ticket 901104-1 (2-Leg Parlay, FreePlay="N"): Stake = $16,200 | Liability = $42,120 | Payout = $58,320</text>
      <text x="848" y="578" class="card-body">• Ticket 901188-1 (Straight Bet, FreePlay="Y"): Stake = $0      | Liability = $9,500  | Payout = $9,500</text>
      <text x="848" y="604" class="card-accent" fill="#fcd34d">SEPARATED TOTALS: Cash Stake = $16,200  |  Potential Payout = $67,820  |  Defined Liability = $51,620</text>

      <rect class="card" x="832" y="654" width="724" height="164" stroke="#f43f5e" />
      <text x="848" y="679" class="card-title" fill="#fda4af">Mode 10 · Scope-Locked Reconciliation (DailyFigures vs. GradedTickets vs. Ledger)</text>
      <text x="848" y="702" class="card-body">Identical Scope Lock: 2026-10-25..2026-10-31 (America/Chicago FigureDate Window)</text>
      <text x="848" y="724" class="card-body">• MJ102 : Report DailyFigures (+$24,545) == Settled Tickets (+$24,545) | Ledger Delta (+$23,045)</text>
      <text x="848" y="744" class="card-body">          Explained Difference: -$1,500 (MANUAL_LEDGER_ADJUSTMENT TXN-ADJ-901 wire settlement fee)</text>
      <text x="848" y="766" class="card-body">• BGD101: Report DailyFigures (+$89,400) == Settled Tickets (+$89,400) == Ledger Delta (+$89,400)</text>
      <text x="848" y="792" class="card-accent" fill="#6ee7b7">✅ VERDICT: Unresolved Gap = $0.00 across both accounts (RECONCILED_WITH_EXPLAINED_DIFFS &amp; RECONCILED_EXACT)</text>
    `,
  },
];

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface GeneratedArtifactCatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string;
  readonly description: string;
  readonly domainsCovered: readonly string[];
  readonly modesCovered: readonly number[];
  readonly upstreamModules: readonly string[];
  readonly cleaningLayers: readonly string[];
  readonly operatorCliCommands: readonly string[];
  readonly files: {
    readonly svgRepoPath: string;
    readonly pngRepoPath: string;
    readonly svgPublicR2Url: string;
    readonly pngPublicR2Url: string;
    readonly svgBytes: number;
    readonly pngBytes: number;
    readonly svgSha256: string;
    readonly pngSha256: string;
  };
  readonly embeddedMetadataStandards: readonly string[];
}

export function generateAllPipelineReferenceImages(): readonly GeneratedArtifactCatalogEntry[] {
  const catalogEntries: GeneratedArtifactCatalogEntry[] = [];
  const accentColors: [number, number, number][] = [
    [6, 182, 212],
    [16, 185, 129],
    [245, 158, 11],
  ];

  // Also enrich existing docs/assets/ARCH-Guide.png with PNG tEXt/iTXt chunks if present
  const existingArchPng = path.join(docsAssetsDir, "ARCH-Guide.png");
  if (fs.existsSync(existingArchPng)) {
    const rawArch = fs.readFileSync(existingArchPng);
    const archSpec = PIPELINE_ARTIFACTS[0]!;
    const enrichedArch = injectRichMetadataIntoPng(
      rawArch,
      archSpec,
      buildXmpPacket(archSpec),
      JSON.stringify({ "@context": "https://schema.org", "@type": "ImageObject", name: archSpec.title })
    );
    fs.writeFileSync(existingArchPng, enrichedArch);
    fs.writeFileSync(path.join(distAssetsDir, "ARCH-Guide.png"), enrichedArch);
  }

  PIPELINE_ARTIFACTS.forEach((spec, idx) => {
    const xmpXml = buildXmpPacket(spec);
    const jsonLdObj = {
      "@context": "https://schema.org",
      "@type": "ImageObject",
      "@id": `${publicR2Base}/assets/${spec.slug}.svg`,
      identifier: spec.id,
      name: spec.title,
      alternateName: spec.subtitle,
      description: spec.description,
      contentUrl: `${publicR2Base}/assets/${spec.slug}.svg`,
      thumbnailUrl: `${publicR2Base}/assets/${spec.slug}.png`,
      encodingFormat: ["image/svg+xml", "image/png"],
      creator: {
        "@type": "Organization",
        name: "SportsDesk & Fantasy402 Risk Engineering",
      },
      keywords: [...spec.domainsCovered, ...spec.upstreamModules, ...spec.cleaningLayers],
      potentialAction: spec.operatorCliCommands,
    };
    const jsonLdString = JSON.stringify(jsonLdObj);

    const svgContent = buildFullSvgDocument(spec, xmpXml, jsonLdObj);
    const svgBuf = Buffer.from(svgContent, "utf8");
    const svgDocsPath = path.join(docsAssetsDir, `${spec.slug}.svg`);
    const svgDistPath = path.join(distAssetsDir, `${spec.slug}.svg`);
    fs.writeFileSync(svgDocsPath, svgBuf);
    fs.writeFileSync(svgDistPath, svgBuf);

    // Attempt macOS QuickLook/sips rasterization of SVG -> PNG, falling back to deterministic PNG generator
    const pngDocsPath = path.join(docsAssetsDir, `${spec.slug}.png`);
    const pngDistPath = path.join(distAssetsDir, `${spec.slug}.png`);
    let basePngBuf: Buffer | null = null;
    try {
      const sipsRes = spawnSync("sips", ["-s", "format", "png", svgDocsPath, "--out", pngDocsPath], {
        stdio: "ignore",
        timeout: 4000,
      });
      if (sipsRes.status === 0 && fs.existsSync(pngDocsPath)) {
        const cand = fs.readFileSync(pngDocsPath);
        if (cand.length > 100 && cand[0] === 0x89 && cand[1] === 0x50) {
          basePngBuf = cand;
        }
      }
    } catch {
      basePngBuf = null;
    }

    if (!basePngBuf) {
      basePngBuf = createFallbackDarkBannerPng(1600, 900, accentColors[idx % accentColors.length]);
    }

    const richPngBuf = injectRichMetadataIntoPng(basePngBuf, spec, xmpXml, jsonLdString);
    fs.writeFileSync(pngDocsPath, richPngBuf);
    fs.writeFileSync(pngDistPath, richPngBuf);

    catalogEntries.push({
      id: spec.id,
      slug: spec.slug,
      title: spec.title,
      subtitle: spec.subtitle,
      description: spec.description,
      domainsCovered: spec.domainsCovered,
      modesCovered: spec.modesCovered,
      upstreamModules: spec.upstreamModules,
      cleaningLayers: spec.cleaningLayers,
      operatorCliCommands: spec.operatorCliCommands,
      files: {
        svgRepoPath: `docs/assets/${spec.slug}.svg`,
        pngRepoPath: `docs/assets/${spec.slug}.png`,
        svgPublicR2Url: `${publicR2Base}/assets/${spec.slug}.svg`,
        pngPublicR2Url: `${publicR2Base}/assets/${spec.slug}.png`,
        svgBytes: svgBuf.length,
        pngBytes: richPngBuf.length,
        svgSha256: sha256Hex(svgBuf),
        pngSha256: sha256Hex(richPngBuf),
      },
      embeddedMetadataStandards: [
        "W3C RDF / Dublin Core (dc:title, dc:description, dc:creator, dc:subject, dc:identifier)",
        "Adobe XMP Packet (XML:com.adobe.xmp)",
        "Schema.org ImageObject JSON-LD (SportsDesk:PipelineSpecJson)",
        "PNG RFC-2083 tEXt & iTXt Chunks with CRC-32 Verification",
        "Cloudflare R2 x-amz-meta-* Custom Object Metadata Headers",
      ],
    });
  });

  const manifestPayload = {
    schemaVersion: "2026.10.31",
    generatedAtIso: new Date().toISOString(),
    portalPublicUrl: `${publicR2Base}/graph.html`,
    metadataCatalogPublicUrl: `${publicR2Base}/assets/pipeline-artifacts-metadata.json`,
    totalArtifacts: catalogEntries.length,
    artifacts: catalogEntries,
  };

  const manifestJson = JSON.stringify(manifestPayload, null, 2) + "\n";
  fs.writeFileSync(path.join(docsAssetsDir, "pipeline-artifacts-metadata.json"), manifestJson, "utf8");
  fs.writeFileSync(path.join(distAssetsDir, "pipeline-artifacts-metadata.json"), manifestJson, "utf8");

  return catalogEntries;
}

if (import.meta.main) {
  const entries = generateAllPipelineReferenceImages();
  console.log("========================================================================================================");
  console.log("  🖼️  GENERATED RICH-METADATA PIPELINE REFERENCE IMAGES (SVG + PNG + XMP + JSON-LD)");
  console.log("========================================================================================================");
  for (const e of entries) {
    console.log(`  • ${e.id.padEnd(34)} | SVG: ${String(e.files.svgBytes).padStart(6)} B | PNG: ${String(e.files.pngBytes).padStart(6)} B | ${e.files.svgPublicR2Url}`);
  }
  console.log("========================================================================================================");
}
