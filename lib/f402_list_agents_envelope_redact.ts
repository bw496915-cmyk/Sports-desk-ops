/**
 * Redact a raw list-agents envelope JSON (local scratch only — never commit input).
 */

import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import { assertRedactedCaptureSweep } from "./f402_har_redaction_sweep.ts";
import { PRODUCTION_PASSWORD_SENTINEL } from "./f402_production_fixture_redaction.ts";
import { prepareProductionOracleFixtureTextFromWireEnvelope } from "./f402_production_oracle_fixture_build.ts";
import { parseListAgentsByAgentWireText } from "./f402_list_agents_wire_boundary.ts";
import { sha256HexText } from "./f402_portal_version_pin.ts";

const PLAYER_PII_KEYS = new Set([
  "Password",
  "NameFirst",
  "Login",
  "customerID",
]);

/** Strip PLAYERS PII before stringify; fixture path clears PLAYERS entirely. */
export function redactListAgentsEnvelopeInMemory(
  envelope: ListAgentsByAgentEnvelope,
): ListAgentsByAgentEnvelope {
  return {
    ...envelope,
    PLAYERS: envelope.PLAYERS.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(row)) {
        if (key === "Password" && typeof val === "string" && val !== "") {
          out[key] = PRODUCTION_PASSWORD_SENTINEL;
        } else if (PLAYER_PII_KEYS.has(key)) {
          out[key] = "[REDACTED]";
        } else {
          out[key] = val;
        }
      }
      return out;
    }),
  };
}

export function redactListAgentsEnvelopeJsonText(rawText: string): string {
  const envelope = parseListAgentsByAgentWireText(rawText);
  const redacted = redactListAgentsEnvelopeInMemory(envelope);
  const text = `${JSON.stringify(redacted, null, 2)}\n`;
  assertRedactedCaptureSweep(text);
  return text;
}

export interface EnvelopeRedactionProof {
  readonly schemaVersion: 1;
  readonly kind: "list-agents-envelope";
  readonly payloadSha256: string;
  readonly generalRowCount: number;
  readonly playersRowCount: number;
  readonly extra: boolean | undefined;
  readonly sweep: { readonly ok: true };
}

export async function buildEnvelopeRedactionProof(
  envelope: ListAgentsByAgentEnvelope,
  redactedText: string,
): Promise<EnvelopeRedactionProof> {
  return {
    schemaVersion: 1,
    kind: "list-agents-envelope",
    payloadSha256: await sha256HexText(redactedText),
    generalRowCount: envelope.GENERAL.length,
    playersRowCount: envelope.PLAYERS.length,
    extra: envelope.EXTRA,
    sweep: { ok: true },
  };
}

/** Scratch → production oracle fixture (placeholders, PLAYERS [], attestation). */
export async function redactScratchEnvelopeToProductionFixture(options: {
  readonly rawText: string;
  readonly redactedByRole: string;
}): Promise<{
  readonly fixtureText: string;
  readonly proof: EnvelopeRedactionProof;
}> {
  const envelope = parseListAgentsByAgentWireText(options.rawText);
  const fixtureText = await prepareProductionOracleFixtureTextFromWireEnvelope(
    envelope,
    options.redactedByRole,
  );
  const proof = await buildEnvelopeRedactionProof(envelope, fixtureText);
  return { fixtureText, proof };
}
