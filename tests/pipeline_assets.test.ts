/**
 * Pipeline reference asset integrity.
 *
 * The generator rasterizes committed diagrams, and the failure mode this test exists for is
 * silent: `sips` cannot read SVG, so an earlier build wrote a 1600x900 dark grid with an accent
 * border and zero text, then embedded full metadata into it. Every file passed `file` and every
 * size looked plausible. These tests decode the committed PNGs themselves (pure Bun/TS, zlib
 * inflate of IDAT, no dependencies) and fail when the raster has no real ink or no label text.
 *
 * Coverage:
 *   - the four catalog artifacts have svg + png + webp triples, all present and digest-matched
 *   - the metadata catalog lists every pipeline SVG/PNG/WebP on disk (no orphan files)
 *   - each PNG carries its tEXt/iTXt/XMP/JSON-LD chunks and passes the ink/color gate
 *   - each WebP is a RIFF/WEBP container, matches the PNG dimensions, and is smaller
 *   - the SVGs are well-formed XML (raw `&` used to break every conforming renderer)
 *   - ARCH-Guide.jpg (an upstream JPEG baseline) still decodes to a content-rich image
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const ROOT = join(import.meta.dir, "..");
const ASSETS_DIR = join(ROOT, "docs", "assets");
const METADATA_PATH = join(ASSETS_DIR, "pipeline-artifacts-metadata.json");

/** The generator gate, mirrored with independent numbers: blank banners fail all three. */
const EXPECTED_ARTIFACT_COUNT = 4;
const MIN_UNIQUE_COLORS = 800;
const MIN_INK_COVERAGE = 0.08;
const MIN_BRIGHT_COVERAGE = 0.008;

// ============================================================================
// CATALOG SHAPE VALIDATION
// ============================================================================
interface ArtifactFiles {
  svgRepoPath: string;
  pngRepoPath: string;
  webpRepoPath: string;
  svgBytes: number;
  pngBytes: number;
  webpBytes: number;
  svgSha256: string;
  pngSha256: string;
  webpSha256: string;
  pngMetadataBearing: boolean;
  webpMetadataBearing: boolean;
  pngMimeType: string;
  webpMimeType: string;
}

interface ArtifactRender {
  rasterizer: string;
  width: number;
  height: number;
  uniqueColors: number;
  inkCoverage: number;
  brightCoverage: number;
}

interface Artifact {
  id: string;
  slug: string;
  title: string;
  operatorCliCommands: string[];
  files: ArtifactFiles;
  render: ArtifactRender;
}

interface Catalog {
  totalArtifacts: number;
  artifacts: Artifact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must be a non-empty string`);
  return value;
}

function requireInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${context} must be a non-negative integer`);
  }
  return value;
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${context} must be a finite number`);
  return value;
}

function requireBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

function requireStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array of strings`);
  return value.map((item, index) => requireString(item, `${context}[${index}]`));
}

function parseFiles(value: unknown, context: string): ArtifactFiles {
  const files = requireRecord(value, context);
  return {
    svgRepoPath: requireString(files["svgRepoPath"], `${context}.svgRepoPath`),
    pngRepoPath: requireString(files["pngRepoPath"], `${context}.pngRepoPath`),
    webpRepoPath: requireString(files["webpRepoPath"], `${context}.webpRepoPath`),
    svgBytes: requireInteger(files["svgBytes"], `${context}.svgBytes`),
    pngBytes: requireInteger(files["pngBytes"], `${context}.pngBytes`),
    webpBytes: requireInteger(files["webpBytes"], `${context}.webpBytes`),
    svgSha256: requireString(files["svgSha256"], `${context}.svgSha256`),
    pngSha256: requireString(files["pngSha256"], `${context}.pngSha256`),
    webpSha256: requireString(files["webpSha256"], `${context}.webpSha256`),
    pngMetadataBearing: requireBoolean(files["pngMetadataBearing"], `${context}.pngMetadataBearing`),
    webpMetadataBearing: requireBoolean(files["webpMetadataBearing"], `${context}.webpMetadataBearing`),
    pngMimeType: requireString(files["pngMimeType"], `${context}.pngMimeType`),
    webpMimeType: requireString(files["webpMimeType"], `${context}.webpMimeType`),
  };
}

function parseRender(value: unknown, context: string): ArtifactRender {
  const render = requireRecord(value, context);
  return {
    rasterizer: requireString(render["rasterizer"], `${context}.rasterizer`),
    width: requireInteger(render["width"], `${context}.width`),
    height: requireInteger(render["height"], `${context}.height`),
    uniqueColors: requireInteger(render["uniqueColors"], `${context}.uniqueColors`),
    inkCoverage: requireNumber(render["inkCoverage"], `${context}.inkCoverage`),
    brightCoverage: requireNumber(render["brightCoverage"], `${context}.brightCoverage`),
  };
}

function parseArtifact(value: unknown, index: number): Artifact {
  const context = `artifacts[${index}]`;
  const artifact = requireRecord(value, context);
  return {
    id: requireString(artifact["id"], `${context}.id`),
    slug: requireString(artifact["slug"], `${context}.slug`),
    title: requireString(artifact["title"], `${context}.title`),
    operatorCliCommands: requireStringArray(artifact["operatorCliCommands"], `${context}.operatorCliCommands`),
    files: parseFiles(artifact["files"], `${context}.files`),
    render: parseRender(artifact["render"], `${context}.render`),
  };
}

function loadCatalog(): Catalog {
  const parsed: unknown = JSON.parse(readFileSync(METADATA_PATH, "utf8"));
  const root = requireRecord(parsed, METADATA_PATH);
  const rawArtifacts = root["artifacts"];
  if (!Array.isArray(rawArtifacts)) throw new Error(`${METADATA_PATH}.artifacts must be an array`);
  return {
    totalArtifacts: requireInteger(root["totalArtifacts"], "totalArtifacts"),
    artifacts: rawArtifacts.map((entry, index) => parseArtifact(entry, index)),
  };
}

const CATALOG = loadCatalog();

// ============================================================================
// DEPENDENCY-FREE PNG DECODE
// ============================================================================
interface DecodedPng {
  width: number;
  height: number;
  /** Packed RGB triplets, 3 bytes per pixel. */
  rgb: Uint8Array;
  /** Per-pixel alpha, or null when the source had no alpha channel. */
  alpha: Uint8Array | null;
}

interface InkStats {
  width: number;
  height: number;
  uniqueColors: number;
  inkCoverage: number;
  brightCoverage: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && PNG_SIGNATURE.every((byte, index) => buf[index] === byte);
}

interface PngChunk {
  type: string;
  data: Buffer;
}

function readPngChunks(png: Buffer): PngChunk[] {
  if (!isPng(png)) throw new Error("not a PNG (bad signature)");
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** Decodes 8-bit non-interlaced PNG (gray, RGB, palette, gray+alpha, RGBA) with zlib inflate. */
function decodePng(png: Buffer): DecodedPng {
  const chunks = readPngChunks(png);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  if (!ihdr) throw new Error("PNG has no IHDR chunk");

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8]!;
  const colorType = ihdr.data[9]!;
  const interlace = ihdr.data[12]!;
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG is unsupported");

  const sourceChannels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (sourceChannels === 0) throw new Error(`unsupported PNG color type ${colorType}`);

  const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
  const inflated = new Uint8Array(zlib.inflateSync(Buffer.concat(idat)));
  const stride = width * sourceChannels;
  if (inflated.length < (stride + 1) * height) throw new Error("PNG IDAT is truncated");

  const scanlines = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!;
    const rowStart = y * (stride + 1) + 1;
    const row = scanlines.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const raw = inflated[rowStart + i]!;
      const left = i >= sourceChannels ? row[i - sourceChannels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= sourceChannels ? previous[i - sourceChannels]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`invalid PNG filter ${filter} on row ${y}`);
      }
      row[i] = value & 0xff;
    }
    previous = row;
  }

  const pixelCount = width * height;
  const rgb = new Uint8Array(pixelCount * 3);
  let alpha: Uint8Array | null = null;

  if (colorType === 3) {
    const plte = chunks.find((chunk) => chunk.type === "PLTE");
    if (!plte) throw new Error("palette PNG without PLTE");
    for (let i = 0; i < pixelCount; i++) {
      const index = scanlines[i]!;
      rgb[i * 3] = plte.data[index * 3] ?? 0;
      rgb[i * 3 + 1] = plte.data[index * 3 + 1] ?? 0;
      rgb[i * 3 + 2] = plte.data[index * 3 + 2] ?? 0;
    }
  } else if (sourceChannels === 3) {
    rgb.set(scanlines);
  } else if (sourceChannels === 4) {
    alpha = new Uint8Array(pixelCount);
    for (let i = 0, j = 0; i < scanlines.length; i += 4, j += 3) {
      rgb[j] = scanlines[i]!;
      rgb[j + 1] = scanlines[i + 1]!;
      rgb[j + 2] = scanlines[i + 2]!;
      alpha[j / 3] = scanlines[i + 3]!;
    }
  } else if (sourceChannels === 2) {
    alpha = new Uint8Array(pixelCount);
    for (let i = 0, j = 0; i < scanlines.length; i += 2, j += 3) {
      rgb[j] = scanlines[i]!;
      rgb[j + 1] = scanlines[i]!;
      rgb[j + 2] = scanlines[i]!;
      alpha[j / 3] = scanlines[i + 1]!;
    }
  } else {
    for (let i = 0, j = 0; i < scanlines.length; i += 1, j += 3) {
      rgb[j] = scanlines[i]!;
      rgb[j + 1] = scanlines[i]!;
      rgb[j + 2] = scanlines[i]!;
    }
  }

  return { width, height, rgb, alpha };
}

/** Fully transparent pixels (qlmanage's padded canvas) are excluded from every ratio. */
function inkStats(decoded: DecodedPng): InkStats {
  const { width, height, rgb, alpha } = decoded;
  const pixelCount = width * height;
  const histogram = new Map<number, number>();

  for (let i = 0; i < pixelCount; i++) {
    if (alpha && alpha[i]! < 8) continue;
    const key = (rgb[i * 3]! << 16) | (rgb[i * 3 + 1]! << 8) | rgb[i * 3 + 2]!;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  let counted = 0;
  let backgroundKey = 0;
  let backgroundCount = -1;
  for (const [key, count] of histogram) {
    counted += count;
    if (count > backgroundCount) {
      backgroundCount = count;
      backgroundKey = key;
    }
  }
  if (counted === 0) throw new Error("image has no opaque pixels");

  const backgroundR = (backgroundKey >> 16) & 0xff;
  const backgroundG = (backgroundKey >> 8) & 0xff;
  const backgroundB = backgroundKey & 0xff;
  let ink = 0;
  let bright = 0;

  for (let i = 0; i < pixelCount; i++) {
    if (alpha && alpha[i]! < 8) continue;
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    if (
      Math.abs(r - backgroundR) > 24 ||
      Math.abs(g - backgroundG) > 24 ||
      Math.abs(b - backgroundB) > 24
    ) {
      ink++;
    }
    if (0.2126 * r + 0.7152 * g + 0.0722 * b >= 200) bright++;
  }

  return {
    width,
    height,
    uniqueColors: histogram.size,
    inkCoverage: ink / counted,
    brightCoverage: bright / counted,
  };
}

// ============================================================================
// HELPERS
// ============================================================================
function repoPath(relativePath: string): string {
  return join(ROOT, relativePath);
}

function sha256(buf: Buffer): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

interface PngTextEntry {
  chunkType: "tEXt" | "iTXt";
  value: string;
}

function pngTextChunks(png: Buffer): Map<string, PngTextEntry> {
  const entries = new Map<string, PngTextEntry>();
  for (const chunk of readPngChunks(png)) {
    if (chunk.type !== "tEXt" && chunk.type !== "iTXt") continue;
    const separator = chunk.data.indexOf(0);
    if (separator <= 0) continue;
    const keyword = chunk.data.toString("latin1", 0, separator);
    const value =
      chunk.type === "tEXt"
        ? chunk.data.toString("latin1", separator + 1)
        : chunk.data.toString("utf8", separator + 4);
    entries.set(keyword, { chunkType: chunk.type, value });
  }
  return entries;
}

function describeStats(slug: string, stats: InkStats): string {
  return (
    `${slug}: ${stats.width}x${stats.height} uniqueColors=${stats.uniqueColors} ` +
    `ink=${(stats.inkCoverage * 100).toFixed(2)}% bright=${(stats.brightCoverage * 100).toFixed(2)}%`
  );
}

// ============================================================================
// CATALOG ↔ DISK PARITY
// ============================================================================
describe("pipeline artifact catalog", () => {
  test("lists all four artifacts as svg + png + webp triples", () => {
    expect(CATALOG.artifacts.length).toBe(EXPECTED_ARTIFACT_COUNT);
    expect(CATALOG.totalArtifacts).toBe(EXPECTED_ARTIFACT_COUNT);

    const slugs = new Set(CATALOG.artifacts.map((artifact) => artifact.slug));
    expect(slugs.size).toBe(EXPECTED_ARTIFACT_COUNT);
    expect(slugs.has("pipeline-dual-surface-gslive-model")).toBe(true);

    for (const artifact of CATALOG.artifacts) {
      const { files } = artifact;
      expect(files.svgRepoPath).toBe(`docs/assets/${artifact.slug}.svg`);
      expect(files.pngRepoPath).toBe(`docs/assets/${artifact.slug}.png`);
      expect(files.webpRepoPath).toBe(`docs/assets/${artifact.slug}.webp`);
      expect(files.pngMetadataBearing).toBe(true);
      expect(files.webpMetadataBearing).toBe(false);
      expect(files.pngMimeType).toBe("image/png");
      expect(files.webpMimeType).toBe("image/webp");
    }
  });

  test("every pipeline image on disk is listed (no orphan assets)", () => {
    const listed = new Set(
      CATALOG.artifacts.flatMap((artifact) => [
        `docs/assets/${artifact.slug}.svg`,
        `docs/assets/${artifact.slug}.png`,
        `docs/assets/${artifact.slug}.webp`,
      ])
    );
    const onDisk = readdirSync(ASSETS_DIR)
      .filter((name) => name.startsWith("pipeline-") && /\.(svg|png|webp)$/.test(name))
      .map((name) => `docs/assets/${name}`)
      .filter((name) => !name.endsWith("pipeline-artifacts-metadata.json"));

    for (const fileName of onDisk) {
      expect({ fileName, listed: listed.has(fileName) }).toEqual({ fileName, listed: true });
      listed.delete(fileName);
    }
    expect([...listed]).toEqual([]);
  });

  test("catalog byte counts and SHA-256 digests match the committed files", () => {
    for (const artifact of CATALOG.artifacts) {
      const { files } = artifact;
      const svg = readFileSync(repoPath(files.svgRepoPath));
      const png = readFileSync(repoPath(files.pngRepoPath));
      const webp = readFileSync(repoPath(files.webpRepoPath));

      expect(svg.length).toBe(files.svgBytes);
      expect(png.length).toBe(files.pngBytes);
      expect(webp.length).toBe(files.webpBytes);

      expect(sha256(svg)).toBe(files.svgSha256);
      expect(sha256(png)).toBe(files.pngSha256);
      expect(sha256(webp)).toBe(files.webpSha256);
    }
  });

  test("operator commands are Bun-only (no node/npm invocations)", () => {
    for (const artifact of CATALOG.artifacts) {
      for (const command of artifact.operatorCliCommands) {
        expect(command.startsWith("./bin/dx") || command.startsWith("bun ")).toBe(true);
        expect(command).not.toContain("node --test");
        expect(command).not.toContain("npm ");
      }
    }
  });
});

// ============================================================================
// BLANK-RASTER DETECTION
// ============================================================================
describe("pipeline PNGs contain real rasters, not the blank banner", () => {
  for (const artifact of CATALOG.artifacts) {
    test(`${artifact.slug}.png passes the ink gate`, () => {
      const png = readFileSync(repoPath(artifact.files.pngRepoPath));
      expect(isPng(png)).toBe(true);

      const decoded = decodePng(png);
      const stats = inkStats(decoded);

      // Dimensions come from the catalog, which records what the rasterizer actually produced.
      expect(stats.width).toBe(artifact.render.width);
      expect(stats.height).toBe(artifact.render.height);
      expect(stats.width).toBeGreaterThanOrEqual(1200);
      expect(stats.height).toBeGreaterThanOrEqual(800);

      // A blank banner has 3 unique colors, ~6% ink, and zero bright pixels.
      expect({
        slug: artifact.slug,
        ok: stats.uniqueColors >= MIN_UNIQUE_COLORS && stats.inkCoverage >= MIN_INK_COVERAGE && stats.brightCoverage >= MIN_BRIGHT_COVERAGE,
        evidence: describeStats(artifact.slug, stats),
      }).toEqual({ slug: artifact.slug, ok: true, evidence: describeStats(artifact.slug, stats) });

      // The catalog's recorded evidence must agree with a fresh decode (drift guard).
      expect(stats.uniqueColors).toBe(artifact.render.uniqueColors);
      expect(stats.inkCoverage).toBeCloseTo(artifact.render.inkCoverage, 3);
      expect(stats.brightCoverage).toBeCloseTo(artifact.render.brightCoverage, 3);
    });

    test(`${artifact.slug}.png survives a Blob round-trip with metadata intact`, async () => {
      const png = readFileSync(repoPath(artifact.files.pngRepoPath));

      // Bun.Image accepts a Blob; the byte round-trip must not rewrite anything.
      const blob = new Blob([png]);
      const roundTripped = Buffer.from(await blob.arrayBuffer());
      expect(roundTripped.equals(png)).toBe(true);

      // Metadata is injected after the last Bun.Image encode, so the Blob bytes still carry it.
      const text = pngTextChunks(roundTripped);
      for (const keyword of ["Title", "XML:com.adobe.xmp", "SportsDesk:PipelineSpecJson"]) {
        expect(text.has(keyword)).toBe(true);
      }
      // iTXt header is keyword\0 + 4 bytes, so the value must start at the XMP/JSON-LD payload.
      expect(text.get("XML:com.adobe.xmp")?.value.startsWith("<")).toBe(true);
      expect(text.get("SportsDesk:PipelineSpecJson")?.value.startsWith("{")).toBe(true);

      const metadata = await new Bun.Image(blob).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.width).toBe(artifact.render.width);
      expect(metadata.height).toBe(artifact.render.height);

      // Bun.Image re-encodes without ancillary chunks: injection must happen AFTER it, never before.
      const reencoded = Buffer.from(await new Bun.Image(blob).png().bytes());
      expect(pngTextChunks(reencoded).size).toBe(0);

      // `.png().blob()` is an output path too: right MIME, re-encoded, still zero metadata chunks.
      const pngBlob = await new Bun.Image(png).png().blob();
      expect(pngBlob.type).toBe("image/png");
      const reencodedFromBlob = Buffer.from(await pngBlob.arrayBuffer());
      expect(pngTextChunks(reencodedFromBlob).size).toBe(0);
      const reencodedMetadata = await new Bun.Image(pngBlob).metadata();
      expect(reencodedMetadata.format).toBe("png");
      expect(reencodedMetadata.width).toBe(artifact.render.width);
      expect(reencodedMetadata.height).toBe(artifact.render.height);
    });

    test(`${artifact.slug}.png keeps its tEXt/iTXt/XMP/JSON-LD chunks`, () => {
      const png = readFileSync(repoPath(artifact.files.pngRepoPath));
      const text = pngTextChunks(png);

      expect(text.has("Title")).toBe(true);
      expect(text.has("Description")).toBe(true);
      expect(text.has("Author")).toBe(true);
      expect(text.has("Source")).toBe(true);
      expect(text.has("XML:com.adobe.xmp")).toBe(true);
      expect(text.has("SportsDesk:PipelineSpecJson")).toBe(true);

      const xmp = text.get("XML:com.adobe.xmp");
      expect(xmp?.chunkType).toBe("iTXt");
      expect(xmp?.value).toContain("<dc:title>");
      expect(xmp?.value).toContain(artifact.id);

      const specJson = text.get("SportsDesk:PipelineSpecJson");
      expect(specJson?.value).toContain('"@type":"ImageObject"');
      expect(specJson?.value).toContain(artifact.slug);
    });
  }

  test("the committed SVGs are well-formed XML and keep their metadata", () => {
    for (const artifact of CATALOG.artifacts) {
      const svgText = readFileSync(repoPath(artifact.files.svgRepoPath), "utf8");
      expect(() => Bun.XML.parse(svgText)).not.toThrow();
      expect(svgText).toContain("<metadata>");
      expect(svgText).toContain('type="application/ld+json"');
      expect(svgText).toContain("<x:xmpmeta");
      // Raw `&` in text used to make every conforming renderer reject the document. CDATA and
      // XML comments may legally contain `&`, so strip both before scanning.
      const withoutCdataAndComments = svgText
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
        .replace(/<!--[\s\S]*?-->/g, "");
      expect(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(withoutCdataAndComments)).toBe(false);
    }
  });
});

// ============================================================================
// WEBP SIBLINGS
// ============================================================================
describe("pipeline WebP siblings", () => {
  for (const artifact of CATALOG.artifacts) {
    test(`${artifact.slug}.webp is a valid, smaller RIFF/WEBP sibling`, async () => {
      const webp = readFileSync(repoPath(artifact.files.webpRepoPath));
      const png = readFileSync(repoPath(artifact.files.pngRepoPath));

      expect(webp.toString("ascii", 0, 4)).toBe("RIFF");
      expect(webp.toString("ascii", 8, 12)).toBe("WEBP");
      expect(riffDeclaredSize(webp)).toBe(webp.length);

      const metadata = await new Bun.Image(webp).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.width).toBe(artifact.render.width);
      expect(metadata.height).toBe(artifact.render.height);

      expect(webp.length).toBeLessThan(png.length);
      // WebP carries no XMP/tEXt: the PNG remains the metadata-bearing download.
      expect(webp.includes("XML:com.adobe.xmp")).toBe(false);
      expect(riffChunkTypes(webp).filter((type) => type === "tEXt" || type === "iTXt" || type === "XMP ")).toEqual([]);

      // `.webp().blob()` is an output path: correct MIME and the same dimensions, still metadata-free.
      const webpBlob = await new Bun.Image(webp).webp({ quality: 82 }).blob();
      expect(webpBlob.type).toBe("image/webp");
      const blobMetadata = await new Bun.Image(webpBlob).metadata();
      expect(blobMetadata.format).toBe("webp");
      expect(blobMetadata.width).toBe(artifact.render.width);
      expect(blobMetadata.height).toBe(artifact.render.height);
      const blobBytes = Buffer.from(await webpBlob.arrayBuffer());
      expect(riffChunkTypes(blobBytes).filter((type) => type === "tEXt" || type === "iTXt" || type === "XMP ")).toEqual([]);
    });
  }
});

/** RIFF header declares the payload size: bytes after the first 8. */
function riffDeclaredSize(webp: Buffer): number {
  return webp.readUInt32LE(4) + 8;
}

/** Walks the RIFF chunk list; chunks are padded to an even byte boundary. */
function riffChunkTypes(webp: Buffer): string[] {
  const types: string[] = [];
  let offset = 12;
  while (offset + 8 <= webp.length) {
    const fourCc = webp.toString("ascii", offset, offset + 4);
    const size = webp.readUInt32LE(offset + 4);
    types.push(fourCc);
    offset += 8 + size + (size % 2);
  }
  return types;
}

// ============================================================================
// ARCH-GUIDE (JPEG PAYLOAD, NOT REGENERATED)
// ============================================================================
describe("ARCH-Guide.jpg", () => {
  test("decodes to a content-rich image and was not replaced by the blank banner", async () => {
    const raw = readFileSync(join(ASSETS_DIR, "ARCH-Guide.jpg"));
    // Upstream JPEG baseline: no PNG chunks, extension matches the payload, copied byte-for-byte.
    expect(raw[0]).toBe(0xff);
    expect(raw[1]).toBe(0xd8);

    const metadata = await new Bun.Image(raw).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBeGreaterThanOrEqual(1200);
    expect(metadata.height).toBeGreaterThanOrEqual(800);

    const png = Buffer.from(await new Bun.Image(raw).png().bytes());
    const stats = inkStats(decodePng(png));
    expect(stats.uniqueColors).toBeGreaterThanOrEqual(5000);
    expect(stats.inkCoverage).toBeGreaterThan(0.3);
    expect(stats.brightCoverage).toBeGreaterThan(0.005);
  });
});
