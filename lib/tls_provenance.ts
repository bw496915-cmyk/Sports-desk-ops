/**
 * @file lib/tls_provenance.ts
 * @description Record the TLS negotiation a capture actually saw.
 *
 * `fetch` hides all of this: no version, no cipher, no certificate, no session reuse. `Bun.connect`
 * exposes it, but only from inside the socket's `open` handler — reading the getters on the promise
 * result returns nulls because the handshake has not completed yet.
 */

export interface PeerCertificate {
  readonly subjectCommonName: string;
  readonly issuerCommonName: string;
  readonly issuerOrganisation: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly fingerprintSha256: string;
}

export interface TlsProvenance {
  readonly host: string;
  readonly port: number;
  readonly tlsVersion: string;
  readonly cipher: { readonly name: string; readonly version: string };
  readonly alpn: string;
  readonly authorized: boolean;
  readonly authorizationError: string | null;
  readonly peer: PeerCertificate | null;
  readonly sessionReused: boolean;
  readonly connectMs: number;
  readonly measuredAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Bun returns `subject`/`issuer` as either a DN string or a `{C,O,CN}` object. */
export function certificateSummary(raw: unknown): PeerCertificate | null {
  const cert = asRecord(raw);
  if (cert === null) return null;
  const subject = asRecord(cert["subject"]);
  const issuer = asRecord(cert["issuer"]);
  const summary: PeerCertificate = {
    subjectCommonName:
      subject === null ? text(cert["subject"]) : text(subject["CN"]),
    issuerCommonName: issuer === null ? "" : text(issuer["CN"]),
    issuerOrganisation: issuer === null ? "" : text(issuer["O"]),
    validFrom: text(cert["valid_from"]),
    validTo: text(cert["valid_to"]),
    fingerprintSha256: text(cert["fingerprint256"]),
  };
  return summary.subjectCommonName === "" && summary.validTo === ""
    ? null
    : summary;
}

interface RawSocket {
  end(): void;
  getTLSVersion?: () => string;
  getCipher?: () => { name?: string; version?: string } | null;
  getPeerCertificate?: () => unknown;
  isSessionReused?: () => boolean;
  alpnProtocol?: string | false | null;
  authorized?: boolean;
  authorizationError?: string | null;
}

export interface ProbeTlsOptions {
  readonly host: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly servername?: string;
}

export async function probeTls(
  options: ProbeTlsOptions,
): Promise<TlsProvenance> {
  const host = options.host;
  const port = options.port ?? 443;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const started = performance.now();

  return await new Promise<TlsProvenance>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`TLS probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (): void => {
      settled = true;
      clearTimeout(timer);
    };

    Bun.connect({
      hostname: host,
      port,
      tls: { servername: options.servername ?? host },
      socket: {
        open(socket: RawSocket) {
          if (settled) {
            socket.end();
            return;
          }
          const cipher = socket.getCipher?.();
          const provenance: TlsProvenance = {
            host,
            port,
            tlsVersion: socket.getTLSVersion?.() ?? "",
            cipher: {
              name: cipher?.name ?? "",
              version: cipher?.version ?? "",
            },
            alpn:
              typeof socket.alpnProtocol === "string"
                ? socket.alpnProtocol
                : "",
            authorized: socket.authorized === true,
            authorizationError: socket.authorizationError ?? null,
            peer: certificateSummary(socket.getPeerCertificate?.()),
            sessionReused: socket.isSessionReused?.() === true,
            connectMs: Math.round(performance.now() - started),
            measuredAt: new Date().toISOString(),
          };
          finish();
          socket.end();
          resolve(provenance);
        },
        data() {
          /* no application data is read */
        },
        error(_socket: RawSocket, error: Error) {
          if (settled) return;
          finish();
          reject(new Error(`TLS connection failed: ${error.message}`));
        },
        close() {
          if (settled) return;
          finish();
          reject(
            new Error("TLS connection closed before the handshake reported"),
          );
        },
      },
    }).catch((error: unknown) => {
      if (settled) return;
      finish();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function formatProvenance(p: TlsProvenance): string {
  const peer = p.peer;
  return [
    `${p.host}:${p.port}  ${p.tlsVersion || "(no version)"}  ${p.cipher.name || "(no cipher)"}`,
    `authorized: ${p.authorized}${p.authorizationError === null ? "" : ` (${p.authorizationError})`} · alpn: ${p.alpn || "(none)"} · reused session: ${p.sessionReused} · ${p.connectMs} ms`,
    peer === null
      ? "peer certificate: unavailable"
      : `peer: CN=${peer.subjectCommonName} · issuer=${peer.issuerOrganisation} ${peer.issuerCommonName} · valid to ${peer.validTo}`,
  ].join("\n");
}
