/**
 * Deterministic JSON + hashing helpers for the evidence-capture core.
 *
 * Capture records must be reproducible: the same logical capture hashes to the
 * same sha256 on every run and machine. `canonicalJson` therefore sorts object
 * keys recursively and emits compact JSON; arrays keep their order because item
 * order is meaningful on the wire.
 */

/** Hash arbitrary text or bytes with sha256 and return lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

/** True for a plain JSON object (not null, not an array, not bytes). */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  return !(value instanceof Uint8Array);
}

/** True for a JSON-safe array. */
export function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Serialize a JSON value with recursively sorted keys and no whitespace.
 *
 * Throws for values JSON cannot represent (`undefined`, `bigint`, functions,
 * non-finite numbers). Callers that accept untrusted data must parse and
 * validate it before hashing; a hash of a lossy serialization would be a lie.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson: non-finite numbers are not JSON");
      }
      return value;
    case "undefined":
      throw new TypeError("canonicalJson: undefined is not JSON");
    case "bigint":
      throw new TypeError("canonicalJson: bigint is not JSON");
    case "function":
    case "symbol":
      throw new TypeError(`canonicalJson: ${typeof value} is not JSON`);
    case "object":
      break;
    default:
      throw new TypeError("canonicalJson: unsupported value type");
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Uint8Array) {
    // Bytes are hashed directly; canonical JSON only accepts JSON values.
    throw new TypeError("canonicalJson: use sha256Hex for bytes");
  }
  if (!isPlainObject(value)) {
    throw new TypeError("canonicalJson: only plain objects are JSON objects");
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) continue;
    sorted[key] = canonicalize(child);
  }
  return sorted;
}

/** Decode bytes as UTF-8 without throwing on malformed sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Encode text as UTF-8 bytes. */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Parse JSON text into `unknown`; returns undefined when it is not JSON. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
