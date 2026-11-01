import { describe, expect, test } from "bun:test";
import { certificateSummary, formatProvenance } from "../lib/tls_provenance.ts";

describe("TLS provenance", () => {
  test("summarizes a structured certificate", () => {
    const summary = certificateSummary({
      subject: { C: "US", CN: "fantasy402.com" },
      issuer: { C: "US", O: "Google Trust Services", CN: "WE1" },
      valid_from: "Oct  9 07:57:03 2026 GMT",
      valid_to: "Jan  7 07:57:03 2027 GMT",
      fingerprint256: "7A:63:B8:34",
    });
    expect(summary).toEqual({
      subjectCommonName: "fantasy402.com",
      issuerCommonName: "WE1",
      issuerOrganisation: "Google Trust Services",
      validFrom: "Oct  9 07:57:03 2026 GMT",
      validTo: "Jan  7 07:57:03 2027 GMT",
      fingerprintSha256: "7A:63:B8:34",
    });
  });

  test("treats a missing certificate as null rather than throwing", () => {
    expect(certificateSummary(null)).toBeNull();
    expect(certificateSummary({})).toBeNull();
    expect(certificateSummary("not a certificate")).toBeNull();
  });

  test("formats a record without inventing a certificate", () => {
    const text = formatProvenance({
      host: "fantasy402.com",
      port: 443,
      tlsVersion: "TLSv1.3",
      cipher: { name: "TLS_AES_128_GCM_SHA256", version: "TLSv1.3" },
      alpn: "",
      authorized: true,
      authorizationError: null,
      peer: null,
      sessionReused: false,
      connectMs: 87,
      measuredAt: "2026-11-01T02:00:00Z",
    });
    expect(text).toContain(
      "fantasy402.com:443  TLSv1.3  TLS_AES_128_GCM_SHA256",
    );
    expect(text).toContain("alpn: (none)");
    expect(text).toContain("peer certificate: unavailable");
    expect(text).toContain("87 ms");
  });

  test("shows the authorization error when the handshake is not trusted", () => {
    const text = formatProvenance({
      host: "example.com",
      port: 443,
      tlsVersion: "TLSv1.2",
      cipher: { name: "ECDHE-RSA-AES128-GCM-SHA256", version: "TLSv1.2" },
      alpn: "h2",
      authorized: false,
      authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      peer: null,
      sessionReused: true,
      connectMs: 12,
      measuredAt: "2026-11-01T02:00:00Z",
    });
    expect(text).toContain(
      "authorized: false (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
    );
    expect(text).toContain("reused session: true");
  });
});
