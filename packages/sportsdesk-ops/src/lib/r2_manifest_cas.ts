/**
 * @file packages/sportsdesk-ops/src/lib/r2_manifest_cas.ts
 * @description Shared R2 Compare-And-Swap (If-Match / If-None-Match) manifest promoter,
 * content-addressed chunk writer, and governance guards for `sportsdesk-ops-reports`.
 */

import {
  R2PreconditionFailedError,
  R2S3Client,
} from "../../../../lib/r2_s3_client.ts";
import { R2_PUBLIC_BASE } from "../../../../lib/r2_staleness.ts";

export const R2_BUCKET = "sportsdesk-ops-reports" as const;

export const RETIRED_FALLBACK_ENV_KEYS = [
  "DOD6_SPINE_PATH",
  "DOD_SPINE_PATH",
  "F402_BETS_JSONL_PATH",
  "DOD_SQLITE_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

export type R2CasEnv = Readonly<Record<string, string | undefined>>;

export class R2ManifestCasError extends Error {
  public readonly code: string;
  public readonly exitCode: number;

  constructor(
    code: string,
    message: string,
    exitCode: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "R2ManifestCasError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function mapR2ErrorExitCode(err: unknown): number {
  if (err instanceof R2ManifestCasError) {
    return err.exitCode;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "exitCode" in err &&
    typeof (err as { readonly exitCode?: unknown }).exitCode === "number"
  ) {
    return (err as { readonly exitCode: number }).exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("ERR_DOD_LEGACY_FALLBACK_REMOVED") ||
    message.includes("ERR_OPS_LOCAL_JSON_FORBIDDEN")
  ) {
    return 78;
  }
  if (message.includes("ERR_CF_TOKEN_BLEED_10000")) {
    return 77;
  }
  if (message.includes("ERR_R2_MANIFEST_CAS_REJECTED")) {
    return 74;
  }
  if (
    message.includes("ERR_DOD_CSR_CONSERVATION_BREACH") ||
    message.includes("ERR_BRIDGE_CHANNEL_CONTAMINATION")
  ) {
    return 70;
  }
  return 65;
}

export function assertR2TokenIsolationAndEnv(env: R2CasEnv = Bun.env): void {
  for (const key of RETIRED_FALLBACK_ENV_KEYS) {
    if (env[key]) {
      throw new R2ManifestCasError(
        "ERR_DOD_LEGACY_FALLBACK_REMOVED",
        `ERR_DOD_LEGACY_FALLBACK_REMOVED: ${key}`,
        78,
      );
    }
  }
  if (env.CLOUDFLARE_R2_API_TOKEN && env.CLOUDFLARE_API_TOKEN) {
    throw new R2ManifestCasError(
      "ERR_CF_TOKEN_BLEED_10000",
      "ERR_CF_TOKEN_BLEED_10000",
      77,
    );
  }
}

export function assertZeroReconciliationGapCents(rawGap: unknown): void {
  const normalized = String(rawGap ?? "0").trim();
  let parsed: bigint;
  try {
    if (!/^[+-]?\d+$/.test(normalized)) {
      throw new Error("non-integer gap");
    }
    parsed = BigInt(normalized);
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_OPS_RECONCILIATION_GAP",
      `ERR_OPS_RECONCILIATION_GAP: invalid unresolved_gap_cents (${normalized})`,
      65,
      cause,
    );
  }
  if (parsed !== 0n) {
    throw new R2ManifestCasError(
      "ERR_OPS_RECONCILIATION_GAP",
      `ERR_OPS_RECONCILIATION_GAP: unresolved_gap_cents=${parsed.toString()}`,
      65,
    );
  }
}

export function resolveR2EndpointFromEnv(
  env: R2CasEnv = Bun.env,
): string | undefined {
  if (env.R2_ENDPOINT && env.R2_ENDPOINT.trim().length > 0) {
    return env.R2_ENDPOINT.trim();
  }
  if (
    env.CLOUDFLARE_ACCOUNT_ID &&
    env.CLOUDFLARE_ACCOUNT_ID.trim().length > 0
  ) {
    return `https://${env.CLOUDFLARE_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`;
  }
  return undefined;
}

export function createScopedR2S3Client(env: R2CasEnv = Bun.env): R2S3Client {
  assertR2TokenIsolationAndEnv(env);
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = resolveR2EndpointFromEnv(env);
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new R2ManifestCasError(
      "ERR_CF_R2_CREDENTIALS_MISSING",
      "ERR_CF_R2_CREDENTIALS_MISSING",
      65,
    );
  }
  const bucket = env.R2_BUCKET_NAME?.trim() || R2_BUCKET;
  const publicBase = env.R2_PUBLIC_URL?.trim() || R2_PUBLIC_BASE;
  return R2S3Client.fromOptions({
    bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    publicBase,
  });
}

export interface CasR2ClientLike {
  headEtag(
    key: string,
    options?: { readonly fetchImpl?: typeof fetch },
  ): Promise<string | null>;
  write(
    key: string,
    data: Uint8Array | string,
    options?: { readonly type?: string },
  ): Promise<number>;
  writeWithMetadata(
    key: string,
    data: Uint8Array | string,
    options?: {
      readonly type?: string;
      readonly metadata?: Readonly<Record<string, string>>;
      readonly ifMatch?: string;
      readonly ifNoneMatch?: string;
      readonly retry?: number;
      readonly retryDelayMs?: number;
      readonly fetchImpl?: typeof fetch;
    },
  ): Promise<number>;
  file(key: string): {
    text(): Promise<string>;
    bytes(): Promise<Uint8Array>;
  };
  stat(key: string): Promise<{
    readonly etag?: string | undefined;
    readonly size?: number | undefined;
  }>;
}

export type R2ManifestProbeResult<T> =
  | {
      readonly exists: false;
      readonly etag: null;
      readonly payload: null;
    }
  | {
      readonly exists: true;
      readonly etag: string;
      readonly payload: T;
    };

export function normalizeStrongETag(etag: string | null): string | null {
  if (etag === null) return null;
  const trimmed = etag.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.replace(/^W\//i, "").trim();
  return normalized.length === 0 ? null : normalized;
}

export async function probeR2ManifestState<T>(
  client: CasR2ClientLike,
  manifestKey: string,
  options?: { readonly fetchImpl?: typeof fetch },
): Promise<R2ManifestProbeResult<T>> {
  let rawEtag: string | null;
  try {
    rawEtag = await client.headEtag(
      manifestKey,
      options?.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    );
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: HEAD ${manifestKey} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }
  const etag = normalizeStrongETag(rawEtag);
  if (etag === null) {
    return { exists: false, etag: null, payload: null };
  }

  let rawText: string;
  try {
    rawText = await client.file(manifestKey).text();
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${manifestKey} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      65,
      cause,
    );
  }

  try {
    const payload = JSON.parse(rawText) as T;
    return { exists: true, etag, payload };
  } catch (cause) {
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: GET ${manifestKey} returned invalid JSON`,
      65,
      cause,
    );
  }
}

export async function writeContentAddressedChunkWithRetry(
  client: CasR2ClientLike,
  chunkBytes: Uint8Array,
  options?: {
    readonly contentType?: string;
    readonly expectedSha256?: string;
    readonly maxRetries?: number;
    readonly baseDelayMs?: number;
  },
): Promise<{
  readonly chunkKey: string;
  readonly merkleRootSha256: string;
  readonly byteLength: number;
}> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(chunkBytes);
  const merkleRootSha256 = hasher.digest("hex");

  if (
    options?.expectedSha256 !== undefined &&
    options.expectedSha256 !== merkleRootSha256
  ) {
    throw new R2ManifestCasError(
      "ERR_R2_CHUNK_MERKLE_MISMATCH",
      `ERR_R2_CHUNK_MERKLE_MISMATCH: expected=${options.expectedSha256} actual=${merkleRootSha256}`,
      65,
    );
  }

  const chunkKey = `chunks/${merkleRootSha256}.bin`;
  const contentType = options?.contentType ?? "application/octet-stream";
  const maxRetries = Math.max(0, Math.trunc(options?.maxRetries ?? 2));
  const baseDelayMs = Math.max(0, Math.trunc(options?.baseDelayMs ?? 15));

  try {
    const existingEtag = normalizeStrongETag(await client.headEtag(chunkKey));
    if (existingEtag !== null) {
      return {
        chunkKey,
        merkleRootSha256,
        byteLength: chunkBytes.byteLength,
      };
    }
  } catch {
    // Fall through to idempotent chunk upload attempts.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0 && baseDelayMs > 0) {
      const jitterMs = Math.floor(Math.random() * 5);
      await Bun.sleep(baseDelayMs * attempt + jitterMs);
    }
    try {
      const written = await client.write(chunkKey, chunkBytes, {
        type: contentType,
      });
      if (written !== chunkBytes.byteLength) {
        throw new R2ManifestCasError(
          "ERR_R2_CHUNK_MERKLE_MISMATCH",
          `ERR_R2_CHUNK_MERKLE_MISMATCH: wrote ${written} of ${chunkBytes.byteLength} bytes to ${chunkKey}`,
          65,
        );
      }
      const uploadedEtag = normalizeStrongETag(await client.headEtag(chunkKey));
      if (uploadedEtag === null) {
        throw new R2ManifestCasError(
          "ERR_R2_CHUNK_MERKLE_MISMATCH",
          `ERR_R2_CHUNK_MERKLE_MISMATCH: missing ETag after upload on ${chunkKey}`,
          65,
        );
      }
      return {
        chunkKey,
        merkleRootSha256,
        byteLength: chunkBytes.byteLength,
      };
    } catch (error) {
      if (
        error instanceof R2ManifestCasError &&
        error.code === "ERR_R2_CHUNK_MERKLE_MISMATCH"
      ) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new R2ManifestCasError(
    "ERR_R2_CHUNK_PUT_RETRY",
    `ERR_R2_CHUNK_PUT_RETRY: failed writing ${chunkKey} after ${maxRetries + 1} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    65,
    lastError,
  );
}

export async function promoteCanonicalManifestWithCas<TManifest>(params: {
  readonly client: CasR2ClientLike;
  readonly sinkId: string;
  readonly manifestKey?: string;
  readonly prevETag: string | null;
  readonly nextGenerationU32: number;
  readonly merkleRootSha256: string;
  readonly manifest: TManifest;
  readonly unresolvedGapCents?: unknown;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}): Promise<{
  readonly manifestKey: string;
  readonly generationKey: string;
  readonly newETag: string | null;
}> {
  assertZeroReconciliationGapCents(params.unresolvedGapCents ?? "0");

  const nextGenU32 = params.nextGenerationU32 >>> 0;
  const manifestKey = params.manifestKey ?? `manifests/${params.sinkId}/latest`;

  const normalizedPrevETag = normalizeStrongETag(params.prevETag);
  if (params.prevETag === null) {
    if (nextGenU32 !== 1) {
      throw new R2ManifestCasError(
        "ERR_R2_MANIFEST_CAS_REJECTED",
        `ERR_R2_MANIFEST_CAS_REJECTED: missing prevETag for non-initial generation ${nextGenU32} on ${manifestKey}`,
        74,
      );
    }
  } else if (normalizedPrevETag === null) {
    throw new R2ManifestCasError(
      "ERR_R2_MANIFEST_CAS_REJECTED",
      `ERR_R2_MANIFEST_CAS_REJECTED: empty prevETag for ${manifestKey}`,
      74,
    );
  }

  const serialized = JSON.stringify(params.manifest);
  const merkle16 = params.merkleRootSha256.slice(0, 16);
  const generationKey = `generations/${params.sinkId}/gen-${nextGenU32}-${merkle16}`;
  await params.client.write(generationKey, serialized, {
    type: "application/json",
  });

  const casHeaders =
    normalizedPrevETag === null
      ? { ifNoneMatch: "*" }
      : { ifMatch: normalizedPrevETag };

  try {
    await params.client.writeWithMetadata(manifestKey, serialized, {
      type: "application/json",
      retry: 0,
      ...casHeaders,
      ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      ...(params.fetchImpl === undefined
        ? {}
        : { fetchImpl: params.fetchImpl }),
    });
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { readonly status?: unknown }).status
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (
      error instanceof R2PreconditionFailedError ||
      status === 412 ||
      /\b412\b|precondition/i.test(message)
    ) {
      throw new R2ManifestCasError(
        "ERR_R2_MANIFEST_CAS_REJECTED",
        `ERR_R2_MANIFEST_CAS_REJECTED: HTTP 412 promoting ${manifestKey} (zero rebases)`,
        74,
        error,
      );
    }
    throw new R2ManifestCasError(
      "ERR_R2_SINK_BACKPRESSURE",
      `ERR_R2_SINK_BACKPRESSURE: PUT ${manifestKey} failed: ${message}`,
      65,
      error,
    );
  }

  const rawNewETag = await params.client.headEtag(
    manifestKey,
    params.fetchImpl === undefined ? {} : { fetchImpl: params.fetchImpl },
  );
  return {
    manifestKey,
    generationKey,
    newETag: normalizeStrongETag(rawNewETag),
  };
}
