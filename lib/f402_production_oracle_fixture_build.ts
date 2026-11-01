/**
 * Gate (j): redacted HAR → production oracle fixture document (pure pipeline).
 *
 * Round-trip: structural redaction rules + label-agnostic oracle equivalence (not structural-only).
 */

import type { ListAgentsByAgentEnvelope } from "./f402_list_agents_by_agent.ts";
import { pickListAgentsEnvelopeFromHar } from "./f402_har_list_agents_extract.ts";
import { assertOracleEquivalentAfterGeneralPlaceholder } from "./f402_oracle_label_agnostic.ts";
import {
  applyProductionGeneralPlaceholders,
  generalRowsDifferOnlyInAgentLabels,
} from "./f402_production_general_placeholders.ts";
import {
  buildProductionOracleFixtureDocument,
  parseProductionOracleFixtureText,
  type ProductionOracleFixture,
} from "./f402_production_fixture_redaction.ts";

export function buildProductionOracleFixtureFromWireEnvelope(
  envelope: ListAgentsByAgentEnvelope,
  redactedByRole: string,
): ProductionOracleFixture {
  const general = applyProductionGeneralPlaceholders(envelope.GENERAL);
  if (!generalRowsDifferOnlyInAgentLabels(envelope.GENERAL, general)) {
    throw new Error(
      "placeholder pass altered non-label GENERAL fields (AgentID/Login only may change)",
    );
  }
  return buildProductionOracleFixtureDocument({
    envelope,
    general,
    redactedByRole,
  });
}

export function buildProductionOracleFixtureFromRedactedHar(
  harRoot: unknown,
  redactedByRole: string,
): ProductionOracleFixture {
  const { envelope } = pickListAgentsEnvelopeFromHar(harRoot);
  return buildProductionOracleFixtureFromWireEnvelope(envelope, redactedByRole);
}

export async function assertProductionFixtureOracleLabelEquivalenceOnEnvelope(
  envelope: ListAgentsByAgentEnvelope,
): Promise<void> {
  const general = applyProductionGeneralPlaceholders(envelope.GENERAL);
  await assertOracleEquivalentAfterGeneralPlaceholder(
    envelope.GENERAL,
    general,
  );
}

export async function assertProductionFixtureOracleLabelEquivalence(
  harRoot: unknown,
): Promise<void> {
  const { envelope } = pickListAgentsEnvelopeFromHar(harRoot);
  await assertProductionFixtureOracleLabelEquivalenceOnEnvelope(envelope);
}

export function serializeProductionOracleFixture(
  fixture: ProductionOracleFixture,
): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Validate at write boundary: redaction rules + oracle semantics under label replacement. */
export async function prepareProductionOracleFixtureTextFromWireEnvelope(
  envelope: ListAgentsByAgentEnvelope,
  redactedByRole: string,
): Promise<string> {
  await assertProductionFixtureOracleLabelEquivalenceOnEnvelope(envelope);
  const fixture = buildProductionOracleFixtureFromWireEnvelope(
    envelope,
    redactedByRole,
  );
  const text = serializeProductionOracleFixture(fixture);
  parseProductionOracleFixtureText(text);
  return text;
}

export async function prepareProductionOracleFixtureTextFromHar(
  harRoot: unknown,
  redactedByRole: string,
): Promise<string> {
  await assertProductionFixtureOracleLabelEquivalence(harRoot);
  const fixture = buildProductionOracleFixtureFromRedactedHar(
    harRoot,
    redactedByRole,
  );
  const text = serializeProductionOracleFixture(fixture);
  parseProductionOracleFixtureText(text);
  return text;
}
