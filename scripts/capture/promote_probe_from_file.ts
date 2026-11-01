/**
 * Promote a scratch webview-probe JSON file into a CaptureStore (2xx default; optional edge failures).
 */
import { parseProbePageResult } from "../../lib/f402_probe.ts";
import { provenanceFromProbePage } from "./provenance_helpers.ts";
import { buildCaptureRecord, type CaptureStore } from "./recorder.ts";
import type {
  CaptureMutationVerdict,
  CaptureRecord,
  CaptureRequestVerdict,
} from "./types.ts";
import { deriveTierWithReason } from "./tier.ts";

function assertPromotableProbe(
  rawProbe: Record<string, unknown>,
  result: ReturnType<typeof parseProbePageResult>,
  probePath: string,
  allowNon2xx: boolean,
): void {
  if (!allowNon2xx && (result.status < 200 || result.status > 299)) {
    throw new Error(
      `refusing to promote non-2xx probe ${probePath} (status ${result.status})`,
    );
  }
  if (rawProbe["readOnlyConfirmed"] !== true) {
    throw new Error(
      `refusing to promote unconfirmed-mutation probe ${probePath}`,
    );
  }
}

function inferRequestVerdictFromScratch(
  rawProbe: Record<string, unknown>,
  bodyStr: string,
  reqContentType: string,
): CaptureRequestVerdict {
  const explicit = rawProbe["requestVerdict"];
  if (
    explicit === "exact" ||
    explicit === "minimal" ||
    explicit === "sentinel" ||
    explicit === "synthetic" ||
    explicit === "mismatched"
  ) {
    return explicit;
  }
  if (
    bodyStr.includes("ticketNumber=-1") ||
    bodyStr.includes('"ticketNumber":"-1"') ||
    bodyStr.includes('"ticketNumber":-1')
  ) {
    return "sentinel";
  }
  if (reqContentType === "application/json") {
    return "exact";
  }
  return "minimal";
}

function inferMutationVerdictFromScratch(
  rawProbe: Record<string, unknown>,
): CaptureMutationVerdict {
  const explicit = rawProbe["mutationVerdict"];
  if (
    explicit === "read" ||
    explicit === "read-inferred" ||
    explicit === "write" ||
    explicit === "unknown"
  ) {
    return explicit;
  }
  return rawProbe["readOnlyConfirmed"] === true ? "read-inferred" : "unknown";
}

export function captureRecordFromProbeScratch(
  rawProbe: Record<string, unknown>,
  options: { allowNon2xx?: boolean; probePath?: string } = {},
): CaptureRecord {
  const probePath = options.probePath ?? "<probe>";
  const result = parseProbePageResult(rawProbe["result"]);
  assertPromotableProbe(
    rawProbe,
    result,
    probePath,
    options.allowNon2xx === true,
  );

  const probeUrlStr = String(rawProbe["url"] ?? "");
  const parsedUrl = new URL(probeUrlStr);
  const capturedAt = String(rawProbe["capturedAt"] ?? new Date().toISOString());
  const bodyStr = String(rawProbe["body"] ?? "");
  const reqContentType =
    typeof rawProbe["requestContentType"] === "string"
      ? rawProbe["requestContentType"]
      : bodyStr.trim().startsWith("{")
        ? "application/json"
        : "application/x-www-form-urlencoded; charset=UTF-8";
  let wireText = result.bodyText ?? result.preview;
  let truncatedPreview = false;
  if (
    result.bodyText === undefined &&
    result.contentType.toLowerCase().includes("json") &&
    result.bytes > result.preview.length
  ) {
    const firstObjEnd = result.preview.indexOf("},{");
    if (firstObjEnd !== -1) {
      wireText = result.preview.trimStart().startsWith("[")
        ? `${result.preview.slice(0, firstObjEnd + 1)}]`
        : `${result.preview.slice(0, firstObjEnd + 1)}]}`;
      truncatedPreview = true;
    }
  }

  return buildCaptureRecord({
    mode: "live",
    capturedAt,
    operation: {
      path: parsedUrl.pathname,
      method: "POST",
    },
    request: {
      url: probeUrlStr,
      method: "POST",
      headers: {
        "content-type": reqContentType,
        "x-requested-with": "XMLHttpRequest",
        authorization: "Bearer <redacted>",
      },
      contentType: reqContentType,
      body: bodyStr,
    },
    response: {
      status: result.status,
      headers: {
        "content-type": result.contentType,
        ...(result.cfRayFromHeader
          ? { "cf-ray": result.cfRayFromHeader }
          : result.cfRay
            ? { "cf-ray": result.cfRay }
            : {}),
      },
      contentType: result.contentType,
      bytes: new TextEncoder().encode(wireText),
      wireBytes: result.bytes,
      truncatedPreview,
    },
    provenance: provenanceFromProbePage(
      {
        portalHost: parsedUrl.host,
        bunVersion: Bun.version,
        ...(rawProbe["backend"] === "chrome" || rawProbe["backend"] === "webkit"
          ? { backend: rawProbe["backend"] }
          : {}),
        headersObserved: rawProbe["headersObserved"] === true,
        request: inferRequestVerdictFromScratch(
          rawProbe,
          bodyStr,
          reqContentType,
        ),
        mutation: inferMutationVerdictFromScratch(rawProbe),
      },
      result,
    ),
    samples: 1,
  });
}

export async function promoteProbeFromFile(options: {
  probePath: string;
  store: CaptureStore;
  allowNon2xx?: boolean;
}): Promise<{
  opPath: string;
  capturedAt: string;
  derivedTier: string;
  derivedTierReason: string;
}> {
  const rawProbe = (await Bun.file(options.probePath).json()) as Record<
    string,
    unknown
  >;
  const captureRecord = captureRecordFromProbeScratch(rawProbe, {
    ...(options.allowNon2xx === undefined
      ? {}
      : { allowNon2xx: options.allowNon2xx }),
    probePath: options.probePath,
  });
  await options.store.write(captureRecord);
  const { tier: derivedTier, reason: derivedTierReason } =
    deriveTierWithReason(captureRecord);
  return {
    opPath: captureRecord.operation.path,
    capturedAt: captureRecord.capturedAt,
    derivedTier,
    derivedTierReason,
  };
}
