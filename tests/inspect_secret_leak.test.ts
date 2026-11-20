/**
 * @file tests/inspect_secret_leak.test.ts
 * @description The fail-closed inspect canary: manifest env secrets and
 * unredacted Bearer/session forms throw; redacted or clean surfaces pass.
 */

import { expect, test } from "bun:test";

import { assertNoSecretLeak } from "../lib/inspect_redactor.ts";

const ENV = {
  R2_SECRET_ACCESS_KEY: "REAL_SECRET_VALUE_12345",
  GSLIVE_SESSION_ID: "REAL_SESSION_VALUE_12345",
};

test("throws when a manifest secret value appears", () => {
  expect(() => assertNoSecretLeak("key=REAL_SECRET_VALUE_12345", ENV)).toThrow(
    /ERR_INSP_SECRET_REDACTION_LEAK/,
  );
});

test("redacted and clean surfaces pass", () => {
  expect(() => assertNoSecretLeak("key=[REDACTED_SECRET]", ENV)).not.toThrow();
  expect(() => assertNoSecretLeak("bucket=test", ENV)).not.toThrow();
});

test("throws on an unredacted Bearer token", () => {
  expect(() =>
    assertNoSecretLeak("Authorization: Bearer abcdef123456", ENV),
  ).toThrow(/ERR_INSP_SECRET_REDACTION_LEAK/);
  expect(() =>
    assertNoSecretLeak("Authorization: Bearer [REDACTED_SECRET]", ENV),
  ).not.toThrow();
});

test("throws on an unredacted session cookie", () => {
  expect(() =>
    assertNoSecretLeak("Cookie: GSLIVE_SESSION_ID=abcdef123456", ENV),
  ).toThrow(/ERR_INSP_SECRET_REDACTION_LEAK/);
  expect(() =>
    assertNoSecretLeak("Cookie: GSLIVE_SESSION_ID=[REDACTED_SECRET]", ENV),
  ).not.toThrow();
});
