/**
 * @file lib/csrf.ts
 * @description Stateless CSRF token issuance and verification using native Bun.CSRF.
 * Enforces stable secret from env across multi-process clusters and HMR lifecycles.
 */

import { CSRF } from "bun";
import { SESSION_IDLE_MS } from "./session.ts";

const SECRET = Bun.env.SPORTSDESK_CSRF_SECRET;

// Fail closed in prod: the random in-memory default is process-local
// and silently breaks on HMR / multi-instance / rolling deploys.
if (!SECRET && Bun.env.NODE_ENV === "production") {
  throw new Error(
    "SPORTSDESK_CSRF_SECRET required in production (see secret_manifest)",
  );
}

export const CSRF_COOKIE_NAME = "sd_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Bun.CSRF's generate options, derived from the platform signature. */
export type CsrfGenerateOptions = NonNullable<
  Parameters<typeof CSRF.generate>[1]
>;
/** Bun.CSRF's verify options, derived from the platform signature. */
export type CsrfVerifyOptions = NonNullable<Parameters<typeof CSRF.verify>[1]>;

/** Bun.CSRF's algorithm union, derived from the platform signature. */
export type CsrfAlgorithm = NonNullable<CsrfGenerateOptions["algorithm"]>;
/** Bun.CSRF's token-encoding union, derived from the platform signature. */
export type CsrfEncoding = NonNullable<CsrfGenerateOptions["encoding"]>;

export interface CsrfOptions {
  secret?: string;
  maxAge?: number;
  /** Bind the token to one session; verification with another id fails. */
  sessionId?: string;
  /** Defaults to Bun's default; issue and verify must agree. */
  algorithm?: CsrfAlgorithm;
  /** Defaults to Bun's default; issue and verify must agree. */
  encoding?: CsrfEncoding;
  /** Token lifetime; defaults to SESSION_IDLE_MS. */
  expiresIn?: number;
}

export const issueCsrf = (opts?: CsrfOptions): string => {
  const sec = opts?.secret ?? SECRET;
  const generateOptions: CsrfGenerateOptions = {
    expiresIn: opts?.expiresIn ?? SESSION_IDLE_MS,
  };
  if (opts?.sessionId !== undefined) {
    generateOptions.sessionId = opts.sessionId;
  }
  if (opts?.algorithm !== undefined) {
    generateOptions.algorithm = opts.algorithm;
  }
  if (opts?.encoding !== undefined) {
    generateOptions.encoding = opts.encoding;
  }
  return sec !== undefined
    ? CSRF.generate(sec, generateOptions)
    : CSRF.generate(undefined, generateOptions);
};

export const verifyCsrf = (token: string, opts?: CsrfOptions): boolean => {
  if (!token) return false;
  try {
    const sec = opts?.secret ?? SECRET;
    const verifyOpts: CsrfVerifyOptions = {
      maxAge: opts?.maxAge ?? SESSION_IDLE_MS,
    };
    if (sec !== undefined) verifyOpts.secret = sec;
    if (opts?.sessionId !== undefined) {
      verifyOpts.sessionId = opts.sessionId;
    }
    if (opts?.algorithm !== undefined) {
      verifyOpts.algorithm = opts.algorithm;
    }
    if (opts?.encoding !== undefined) {
      verifyOpts.encoding = opts.encoding;
    }
    return CSRF.verify(token, verifyOpts);
  } catch {
    return false; // malformed token → treat as invalid, never throw to caller
  }
};
