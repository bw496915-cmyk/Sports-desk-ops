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

test("rejects provider-shaped credentials without an env value", () => {
  expect(() => assertNoSecretLeak("key AKIAABCDEFGHIJKLMNOP", {})).toThrow(
    /Provider-shaped credential/,
  );
  expect(() =>
    assertNoSecretLeak(
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
      {},
    ),
  ).toThrow(/Provider-shaped credential/);
  expect(() =>
    assertNoSecretLeak("-----BEGIN RSA PRIVATE KEY-----", {}),
  ).toThrow(/Provider-shaped credential/);
});

test("rejects unredacted URL secrets and DSN passwords", () => {
  expect(() =>
    assertNoSecretLeak("https://x.test/?token=abcdef123456", {}),
  ).toThrow(/URL secret/);
  expect(() =>
    assertNoSecretLeak("https://x.test/?token=[REDACTED_SECRET]", {}),
  ).not.toThrow();
  expect(() =>
    assertNoSecretLeak("postgres://user:password123@db.test/x", {}),
  ).toThrow(/DSN password/);
  expect(() =>
    assertNoSecretLeak("postgres://user:[REDACTED_SECRET]@db.test/x", {}),
  ).not.toThrow();
});

test("rejects an unredacted session cookie but allows ordinary cookies", () => {
  expect(() =>
    assertNoSecretLeak("Cookie: sd_session=abcdef123456", {}),
  ).toThrow(/Unredacted Bearer\/session token/);
  expect(() =>
    assertNoSecretLeak("Cookie: sd_session=[REDACTED_SECRET]", {}),
  ).not.toThrow();
  expect(() => assertNoSecretLeak("Cookie: theme=dark", {})).not.toThrow();
});
