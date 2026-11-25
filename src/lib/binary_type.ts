/**
 * @file src/lib/binary_type.ts
 * @description Bun 1.4.5 `BinaryType` contracts, zero-copy payload views, and WebSocket/socket frame helpers.
 *
 * Bun defines distinct `binaryType` unions per transport surface:
 * - TCP/TLS (`Bun.listen`/`Bun.connect`) & UDP (`Bun.udpSocket`): `Bun.BinaryType` = `"arraybuffer" | "buffer" | "uint8array"` (default `"buffer"`)
 * - Server WebSocket (`ServerWebSocket.binaryType`): `"nodebuffer" | "arraybuffer" | "uint8array" | "blob"` (default `"nodebuffer"`)
 * - Client WebSocket (`WebSocket.binaryType`): `"arraybuffer" | "blob" | "nodebuffer"` (default `"nodebuffer"`)
 */

import type {
  BinaryType,
  BinaryTypeList,
  ServerWebSocket,
  SocketHandler,
} from "bun";

export type { BinaryType, BinaryTypeList };

export type BinaryPayload<T extends BinaryType = BinaryType> =
  BinaryTypeList[T];

export type ServerWsBinaryType = NonNullable<ServerWebSocket["binaryType"]>;
export type ClientWsBinaryType = WebSocket["binaryType"] | "nodebuffer";
export type JscSerializeBinaryType = "arraybuffer" | "nodebuffer";

export const SOCKET_BINARY_TYPES = [
  "arraybuffer",
  "buffer",
  "uint8array",
] as const satisfies readonly BinaryType[];

export const SERVER_WS_BINARY_TYPES = [
  "nodebuffer",
  "arraybuffer",
  "uint8array",
  "blob",
] as const satisfies readonly ServerWsBinaryType[];

export const CLIENT_WS_BINARY_TYPES = [
  "arraybuffer",
  "blob",
  "nodebuffer",
] as const satisfies readonly ClientWsBinaryType[];

export const JSC_SERIALIZE_BINARY_TYPES = [
  "arraybuffer",
  "nodebuffer",
] as const satisfies readonly JscSerializeBinaryType[];

const SOCKET_BINARY_TYPE_SET: ReadonlySet<string> = new Set(
  SOCKET_BINARY_TYPES,
);
const SERVER_WS_BINARY_TYPE_SET: ReadonlySet<string> = new Set(
  SERVER_WS_BINARY_TYPES,
);
const CLIENT_WS_BINARY_TYPE_SET: ReadonlySet<string> = new Set(
  CLIENT_WS_BINARY_TYPES,
);
const JSC_SERIALIZE_BINARY_TYPE_SET: ReadonlySet<string> = new Set(
  JSC_SERIALIZE_BINARY_TYPES,
);

const UTF8_DECODER = new TextDecoder();

export function isSocketBinaryType(value: unknown): value is BinaryType {
  return typeof value === "string" && SOCKET_BINARY_TYPE_SET.has(value);
}

export function isServerWsBinaryType(
  value: unknown,
): value is ServerWsBinaryType {
  return typeof value === "string" && SERVER_WS_BINARY_TYPE_SET.has(value);
}

export function isClientWsBinaryType(
  value: unknown,
): value is ClientWsBinaryType {
  return typeof value === "string" && CLIENT_WS_BINARY_TYPE_SET.has(value);
}

export function isJscSerializeBinaryType(
  value: unknown,
): value is JscSerializeBinaryType {
  return typeof value === "string" && JSC_SERIALIZE_BINARY_TYPE_SET.has(value);
}

export type BinaryPayloadKind =
  "buffer" | "uint8array" | "arraybuffer" | "blob" | "string" | "unknown";

export interface ClassifiedBinaryPayload {
  readonly kind: BinaryPayloadKind;
  readonly ctor: string;
  readonly byteLength: number | null;
  readonly isBuffer: boolean;
  readonly isUint8Array: boolean;
  readonly isArrayBuffer: boolean;
  readonly isBlob: boolean;
}

/**
 * Runtime payload classifier that distinguishes `Buffer` from bare `Uint8Array`
 * (`Buffer` inherits from `Uint8Array`, so `instanceof Uint8Array` alone conflates them).
 */
export function classifyBinaryPayload(value: unknown): ClassifiedBinaryPayload {
  const isBuffer = Buffer.isBuffer(value);
  const isUint8Array = value instanceof Uint8Array;
  const isArrayBuffer = value instanceof ArrayBuffer;
  const isBlob = value instanceof Blob;
  const ctor =
    (value as { constructor?: { name?: string } } | null | undefined)
      ?.constructor?.name ?? typeof value;

  if (isBuffer) {
    return {
      kind: "buffer",
      ctor,
      byteLength: value.byteLength,
      isBuffer: true,
      isUint8Array: true,
      isArrayBuffer: false,
      isBlob: false,
    };
  }
  if (isUint8Array) {
    return {
      kind: "uint8array",
      ctor,
      byteLength: value.byteLength,
      isBuffer: false,
      isUint8Array: true,
      isArrayBuffer: false,
      isBlob: false,
    };
  }
  if (isArrayBuffer) {
    return {
      kind: "arraybuffer",
      ctor,
      byteLength: value.byteLength,
      isBuffer: false,
      isUint8Array: false,
      isArrayBuffer: true,
      isBlob: false,
    };
  }
  if (isBlob) {
    return {
      kind: "blob",
      ctor,
      byteLength: value.size,
      isBuffer: false,
      isUint8Array: false,
      isArrayBuffer: false,
      isBlob: true,
    };
  }
  if (typeof value === "string") {
    return {
      kind: "string",
      ctor: "String",
      byteLength: Buffer.byteLength(value),
      isBuffer: false,
      isUint8Array: false,
      isArrayBuffer: false,
      isBlob: false,
    };
  }
  return {
    kind: "unknown",
    ctor,
    byteLength: null,
    isBuffer: false,
    isUint8Array: false,
    isArrayBuffer: false,
    isBlob: false,
  };
}

/**
 * Returns a zero-copy bare `Uint8Array` view over any `Bun.BinaryType` payload or `ArrayBufferView`.
 */
export function toUint8ArrayView(
  payload: BinaryPayload | ArrayBufferView,
): Uint8Array {
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Returns a zero-copy `DataView` scoped to the exact byte window of any `Bun.BinaryType` payload
 * (bridges Bun 1.4.5's `// TODO: DataView` in `BinaryTypeList` for binary header parsing).
 */
export function toDataView(payload: BinaryPayload | ArrayBufferView): DataView {
  if (payload instanceof ArrayBuffer) {
    return new DataView(payload);
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Returns a zero-copy Node `Buffer` view over any `Bun.BinaryType` payload or `ArrayBufferView`.
 */
export function toBufferView(payload: BinaryPayload | ArrayBufferView): Buffer {
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Returns an `ArrayBuffer` covering the exact byte range of `payload`.
 * Zero-copy when `payload` is already an `ArrayBuffer` or a full-span view over a plain `ArrayBuffer`;
 * copies only the exact slice when viewing a subrange or `SharedArrayBuffer`.
 */
export function toArrayBufferExact(
  payload: BinaryPayload | ArrayBufferView,
): ArrayBuffer {
  if (payload instanceof ArrayBuffer) {
    return payload;
  }
  if (
    payload.buffer instanceof ArrayBuffer &&
    payload.byteOffset === 0 &&
    payload.byteLength === payload.buffer.byteLength
  ) {
    return payload.buffer;
  }
  const copy = new Uint8Array(payload.byteLength);
  copy.set(
    new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
  );
  return copy.buffer;
}

/**
 * Fail-closed runtime contract check asserting that a delivered socket payload matches `expected`.
 */
export function assertBinaryTypeMatch<T extends BinaryType>(
  expected: T,
  actual: unknown,
): BinaryTypeList[T] {
  const classified = classifyBinaryPayload(actual);
  if (classified.kind !== expected) {
    throw new TypeError(
      `ERR_BINARY_TYPE_MISMATCH: expected ${expected}, received ${classified.kind} (${classified.ctor})`,
    );
  }
  return actual as BinaryTypeList[T];
}

/**
 * Decodes a synchronous string or binary socket/WS frame to UTF-8 text without allocating a per-frame `TextDecoder`.
 */
export function decodeBinaryFrameText(
  payload: string | BinaryPayload | ArrayBufferView,
): string {
  if (typeof payload === "string") return payload;
  return UTF8_DECODER.decode(toUint8ArrayView(payload));
}

/**
 * Decodes any client or server WebSocket `event.data` (`string`, `ArrayBuffer`, `Uint8Array`, `Buffer`, `Blob`) to UTF-8 text.
 */
export async function decodeWsEventText(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return decodeBinaryFrameText(data);
  }
  if (data instanceof Blob) {
    return data.text();
  }
  return null;
}

/**
 * Creates a strongly typed `Bun.SocketHandler<Data, T>` bound to a specific `Bun.BinaryType`.
 */
export function createSocketBinaryHandler<
  Data = unknown,
  T extends BinaryType = "buffer",
>(
  binaryType: T,
  handlers: Omit<SocketHandler<Data, T>, "binaryType">,
): SocketHandler<Data, T> {
  return {
    ...handlers,
    binaryType,
  };
}
