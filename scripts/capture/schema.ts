/**
 * Value-free schema inference ("skeletons") for capture records.
 *
 * A skeleton keeps field names, JSON types, array item shape, nullability and —
 * for a small allow-list of enum-shaped keys — the literal values, which are
 * public contract facts (e.g. `type: "B"`). It never keeps a body value:
 * strings are reduced to their type, and anonymous objects inside arrays are
 * merged into one item skeleton.
 *
 * Caps keep a pathological response (deep nesting, enormous row counts) from
 * turning into an unbounded record; truncation is recorded honestly instead of
 * silently dropping structure.
 */

import { decodeUtf8, isPlainObject, tryParseJson } from "./json.ts";
import { isSensitiveKey, scanPii } from "./redact.ts";
import type {
  Skeleton,
  SkeletonArray,
  SkeletonObject,
  SkeletonScalar,
  SkeletonScalarType,
} from "./types.ts";

export const SCHEMA_MAX_DEPTH = 8;
export const SCHEMA_MAX_FIELDS = 256;
export const SCHEMA_MAX_ARRAY_SAMPLES = 64;
export const SCHEMA_MAX_NODES = 5_000;
export const SCHEMA_MAX_BYTES = 1_000_000;
export const SCHEMA_MAX_ENUM_CANDIDATES = 8;

/**
 * Keys whose short literal values are contract facts worth publishing. A
 * blanket value summary would leak IDs, names and timestamps, so enum
 * candidates are collected for these keys only.
 */
const ENUM_KEY_RE =
  /^(?:type|actions|operation|rro|status|result|wagertype|mode|kind|code|action|sport|period|currency|unit|direction)$/i;
const ENUM_TOKEN_RE = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;

interface InferState {
  nodes: number;
}

export interface InferOptions {
  depth?: number;
  key?: string;
  maxDepth?: number;
}

/** Infer a skeleton for one parsed JSON value. */
export function inferSkeleton(
  value: unknown,
  options: InferOptions = {},
): Skeleton {
  const state: InferState = { nodes: 0 };
  const skeleton = infer(
    value,
    options.depth ?? 0,
    options.key,
    state,
    options.maxDepth ?? SCHEMA_MAX_DEPTH,
  );
  return normalizeSkeleton(skeleton);
}

/**
 * Infer a skeleton for raw response/request bytes. JSON is parsed only when the
 * declared content type says so (or the payload actually parses); form bodies
 * become a string-valued object; text types stay `string`; binary is `unknown`.
 */
export function inferSkeletonFromBytes(
  bytes: Uint8Array,
  contentType: string,
): Skeleton {
  if (bytes.length === 0) return { type: "null", nullable: true };
  if (bytes.length > SCHEMA_MAX_BYTES) {
    return { type: "unknown", nullable: false, truncated: true };
  }
  const mediaType = contentType.toLowerCase();
  const text = decodeUtf8(bytes);

  if (mediaType.includes("json")) {
    const parsed = tryParseJson(text);
    if (parsed === undefined) {
      return { type: "unknown", nullable: false, truncated: true };
    }
    return inferSkeleton(parsed);
  }
  if (mediaType.includes("x-www-form-urlencoded")) {
    return inferFormSkeleton(text);
  }
  if (
    mediaType.startsWith("text/") ||
    mediaType.includes("xml") ||
    mediaType.includes("html")
  ) {
    return { type: "string", nullable: false };
  }
  if (mediaType.length === 0) {
    const parsed = tryParseJson(text);
    if (parsed !== undefined) return inferSkeleton(parsed);
    return { type: "string", nullable: false };
  }
  return { type: "unknown", nullable: false };
}

/** Form bodies are represented as an object whose leaves are strings. */
export function inferFormSkeleton(body: string): Skeleton {
  const params = new URLSearchParams(body);
  const fields: Record<string, Skeleton> = {};
  for (const key of [...new Set(params.keys())].sort()) {
    fields[key] = { type: "string", nullable: false };
  }
  return { type: "object", nullable: false, fields };
}

function infer(
  value: unknown,
  depth: number,
  key: string | undefined,
  state: InferState,
  maxDepth: number,
): Skeleton {
  state.nodes += 1;
  if (state.nodes > SCHEMA_MAX_NODES || depth > maxDepth) {
    return { type: "unknown", nullable: value === null, truncated: true };
  }
  if (value === null) return { type: "null", nullable: true };
  if (typeof value === "string") {
    return scalarSkeleton("string", value, key);
  }
  if (typeof value === "number") {
    return { type: "number", nullable: false };
  }
  if (typeof value === "boolean") {
    return scalarSkeleton("boolean", value, key);
  }
  if (typeof value === "bigint" || typeof value === "undefined") {
    return { type: "unknown", nullable: false, truncated: true };
  }
  if (Array.isArray(value)) {
    let items: Skeleton | null = null;
    let truncated = false;
    const sample = value.slice(0, SCHEMA_MAX_ARRAY_SAMPLES);
    if (value.length > sample.length) truncated = true;
    for (const item of sample) {
      const itemSkeleton = infer(item, depth + 1, undefined, state, maxDepth);
      items =
        items === null ? itemSkeleton : mergeSkeletons(items, itemSkeleton);
    }
    const arraySkeleton: SkeletonArray = {
      type: "array",
      nullable: false,
      items,
    };
    if (truncated) arraySkeleton.truncated = true;
    return arraySkeleton;
  }
  if (isPlainObject(value)) {
    const fields: Record<string, Skeleton> = {};
    const keys = Object.keys(value).sort();
    const emitted = keys.slice(0, SCHEMA_MAX_FIELDS);
    for (const fieldKey of emitted) {
      fields[fieldKey] = infer(
        value[fieldKey],
        depth + 1,
        fieldKey,
        state,
        maxDepth,
      );
    }
    const objectSkeleton: SkeletonObject = {
      type: "object",
      nullable: false,
      fields,
    };
    if (keys.length > emitted.length) objectSkeleton.truncated = true;
    return objectSkeleton;
  }
  return { type: "unknown", nullable: false, truncated: true };
}

function scalarSkeleton(
  type: SkeletonScalarType,
  value: string | boolean,
  key: string | undefined,
): SkeletonScalar {
  const skeleton: SkeletonScalar = { type, nullable: false };
  if (key !== undefined && isEnumKey(key) && isSafeEnumValue(value)) {
    skeleton.enumCandidates = [String(value)];
  }
  return skeleton;
}

function isEnumKey(key: string): boolean {
  return !isSensitiveKey(key) && ENUM_KEY_RE.test(key);
}

function isSafeEnumValue(value: string | boolean): boolean {
  if (typeof value === "boolean") return true;
  if (!ENUM_TOKEN_RE.test(value)) return false;
  return scanPii(value).length === 0;
}

/** Merge two skeletons observed for the same position (array items / samples). */
export function mergeSkeletons(left: Skeleton, right: Skeleton): Skeleton {
  if (left.type !== right.type) {
    if (left.type === "null") return withNullable(right);
    if (right.type === "null") return withNullable(left);
    return {
      type: "unknown",
      nullable: left.nullable || right.nullable,
    };
  }
  switch (left.type) {
    case "object": {
      if (right.type !== "object") return conflictingSkeleton(left, right);
      const fields: Record<string, Skeleton> = { ...left.fields };
      for (const [key, value] of Object.entries(right.fields)) {
        const previous = fields[key];
        fields[key] =
          previous === undefined ? value : mergeSkeletons(previous, value);
      }
      const merged: SkeletonObject = {
        type: "object",
        nullable: left.nullable || right.nullable,
        fields,
      };
      if (left.truncated === true || right.truncated === true) {
        merged.truncated = true;
      }
      return merged;
    }
    case "array": {
      if (right.type !== "array") return conflictingSkeleton(left, right);
      let items: Skeleton | null;
      if (left.items === null) items = right.items;
      else if (right.items === null) items = left.items;
      else items = mergeSkeletons(left.items, right.items);
      const merged: SkeletonArray = {
        type: "array",
        nullable: left.nullable || right.nullable,
        items,
      };
      if (left.truncated === true || right.truncated === true) {
        merged.truncated = true;
      }
      return merged;
    }
    case "null":
      return { type: "null", nullable: true };
    default: {
      if (
        right.type === "object" ||
        right.type === "array" ||
        right.type === "null"
      ) {
        return conflictingSkeleton(left, right);
      }
      const merged: SkeletonScalar = {
        type: left.type,
        nullable: left.nullable || right.nullable,
      };
      const candidates = mergeEnumCandidates(left, right);
      if (candidates.length > 0) merged.enumCandidates = candidates;
      if (left.truncated === true || right.truncated === true) {
        merged.truncated = true;
      }
      return merged;
    }
  }
}

/**
 * Defensive arm: callers only merge skeletons recorded for the same position,
 * so differing types are represented honestly as `unknown` rather than forced.
 */
function conflictingSkeleton(left: Skeleton, right: Skeleton): Skeleton {
  return { type: "unknown", nullable: left.nullable || right.nullable };
}

function mergeEnumCandidates(
  left: SkeletonScalar,
  right: SkeletonScalar,
): string[] {
  const values = new Set<string>();
  for (const candidate of left.enumCandidates ?? []) values.add(candidate);
  for (const candidate of right.enumCandidates ?? []) values.add(candidate);
  return [...values].sort().slice(0, SCHEMA_MAX_ENUM_CANDIDATES);
}

function withNullable(skeleton: Skeleton): Skeleton {
  switch (skeleton.type) {
    case "object":
      return { ...skeleton, nullable: true };
    case "array":
      return { ...skeleton, nullable: true };
    default:
      return { ...skeleton, nullable: true };
  }
}

/** Recursively sort object fields and enum candidates for deterministic output. */
export function normalizeSkeleton(skeleton: Skeleton): Skeleton {
  switch (skeleton.type) {
    case "object": {
      const fields: Record<string, Skeleton> = {};
      for (const key of Object.keys(skeleton.fields).sort()) {
        const child = skeleton.fields[key];
        if (child !== undefined) fields[key] = normalizeSkeleton(child);
      }
      const out: SkeletonObject = {
        type: "object",
        nullable: skeleton.nullable,
        fields,
      };
      if (skeleton.truncated === true) out.truncated = true;
      return out;
    }
    case "array": {
      const out: SkeletonArray = {
        type: "array",
        nullable: skeleton.nullable,
        items:
          skeleton.items === null ? null : normalizeSkeleton(skeleton.items),
      };
      if (skeleton.truncated === true) out.truncated = true;
      return out;
    }
    default: {
      const out: SkeletonScalar = {
        type: skeleton.type,
        nullable: skeleton.nullable,
      };
      if (skeleton.enumCandidates !== undefined) {
        out.enumCandidates = [...new Set(skeleton.enumCandidates)].sort();
      }
      if (skeleton.truncated === true) out.truncated = true;
      return out;
    }
  }
}
