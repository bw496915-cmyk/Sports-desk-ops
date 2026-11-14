import { assertHexColor } from "./perceptual.ts";

export const TOKENS_SCHEMA_VERSION = "1.3.0";

export type TokensContractCode =
  | "ERR_TOKENS_SHAPE"
  | "ERR_TOKENS_VERSION"
  | "ERR_TOKENS_FLOAT_FORBIDDEN"
  | "ERR_TOKENS_HEX_PARITY"
  | "ERR_TOKENS_INGESTION_INCOMPLETE"
  | "ERR_TOKENS_BRIDGES_INCOMPLETE"
  | "ERR_TOKENS_BITSET_RANGE"
  | "ERR_TOKENS_SLA_ORDER"
  | "ERR_A11Y_FOCUS_TRAP_LOOP";

export class TokensContractError extends Error {
  override readonly name = "TokensContractError";
  constructor(
    readonly code: TokensContractCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export type UiSlot = {
  readonly key: string;
  readonly tokenName: string;
  readonly hex: string;
  readonly role: "surface" | "border" | "text";
};

export type SurfaceSlot = {
  readonly key: string;
  readonly tokenName: string;
  readonly hex: string;
};

export type IngestionChannel = {
  readonly key: string;
  readonly layerId: string;
  readonly tokenName: string;
  readonly hex: string;
  readonly channelCode: string;
  readonly channelId: number;
  readonly slaKind: "latency" | "sentinel_drop";
  readonly slaTensOfMs: number;
  readonly bridgeKeys: readonly string[];
  readonly bridgeMask4: number;
  readonly wireAliases: readonly string[];
};

export type Bridge = {
  readonly key: string;
  readonly bridgeId: number;
  readonly bridgeKey: string;
};

export type SlaState = {
  readonly key: "fresh" | "warn" | "stale" | "poison";
  readonly rank: number;
  readonly tokenName: string;
  readonly hex: string;
  readonly ageCeilingMilliSla: number | undefined;
};

export type BitFlag = { readonly name: string; readonly bit: number };

export type KeymapSlot = {
  readonly key: string;
  readonly slotIndex: number;
  readonly keyCode: string;
  readonly mode: number;
  readonly modeId: string;
  readonly uiStateFlag: string;
};

export type GatesMilli = {
  readonly wcagBodyTextMinMilli: number;
  readonly wcagAaaMutedMinMilli: number;
  readonly wcagInteractiveMinMilli: number;
  readonly crossStateDeltaE00MinMilli: number;
  readonly slaFreshStaleDeltaE00MinMilli: number;
  readonly bitset32MaxBit: number;
  readonly keymapSlotCount: number;
};

export type TokensV13 = {
  readonly version: string;
  readonly gates: GatesMilli;
  readonly surfaces: readonly SurfaceSlot[];
  readonly ui: readonly UiSlot[];
  readonly ingestion: readonly IngestionChannel[];
  readonly bridges: readonly Bridge[];
  readonly sla: readonly SlaState[];
  readonly betLegFlags: readonly BitFlag[];
  readonly uiStateFlags: readonly BitFlag[];
  readonly keymap: readonly KeymapSlot[];
  readonly tokenMap: ReadonlyMap<string, string>;
  readonly tauStarBasisPoints: number;
};

/** `[ui.*]` / `[surfaces.*]` token names whose `[tokens]` key predates the CSS name. */
export const LEGACY_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  "--sd-surface-card": "sd-surface-panel",
  "--sd-surface-border": "sd-border-default",
};

export const REQUIRED_LEGACY_TOKEN_KEYS: readonly string[] = [
  "sd-surface-panel",
  "sd-border-default",
  "sd-theme-emerald",
];

const KEY_CODES: readonly string[] = [
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Digit0",
];

const SLA_KEYS = ["fresh", "warn", "stale", "poison"] as const;

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(value: unknown, context: string): Table {
  if (!isTable(value)) {
    throw new TokensContractError(
      "ERR_TOKENS_SHAPE",
      `${context} must be a table`,
    );
  }
  return value;
}

function text(source: Table, key: string, context: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TokensContractError(
      "ERR_TOKENS_SHAPE",
      `${context}.${key} must be a non-empty string`,
    );
  }
  return value;
}

function integer(
  source: Table,
  key: string,
  context: string,
  min: number,
  max: number,
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TokensContractError(
      "ERR_TOKENS_FLOAT_FORBIDDEN",
      `${context}.${key} must be an integer, got ${JSON.stringify(value)}`,
    );
  }
  if (value < min || value > max) {
    throw new TokensContractError(
      "ERR_TOKENS_SHAPE",
      `${context}.${key} must be in [${min}, ${max}], got ${value}`,
    );
  }
  return value;
}

function stringList(source: Table, key: string, context: string): string[] {
  const value = source[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new TokensContractError(
      "ERR_TOKENS_INGESTION_INCOMPLETE",
      `${context}.${key} must be a non-empty string array`,
    );
  }
  return value as string[];
}

function hex(source: Table, key: string, context: string): string {
  const value = text(source, key, context);
  try {
    assertHexColor(value, `${context}.${key}`);
  } catch (cause) {
    throw new TokensContractError(
      "ERR_TOKENS_SHAPE",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  return value;
}

/** Strips strings and comments so float literals are found only in value positions. */
function codeOutsideStrings(line: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let charIndex = 0; charIndex < line.length; charIndex += 1) {
    const char = line[charIndex] ?? "";
    if (quote !== null) {
      if (char === "\\" && quote === '"') charIndex += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += " ";
      continue;
    }
    if (char === "#") break;
    out += char;
  }
  return out;
}

const FLOAT_LITERAL =
  /(?:^|[=[,\s])[-+]?(?:\d[\d_]*\.\d[\d_]*(?:[eE][-+]?\d+)?|\d[\d_]*[eE][-+]?\d+|inf|nan)(?=$|[\s,\]])/;

export function findFloatLiterals(tomlText: string): string[] {
  const findings: string[] = [];
  const lines = tomlText.split("\n");
  for (const [lineIndex, line] of lines.entries()) {
    const code = codeOutsideStrings(line);
    const equalsAt = code.indexOf("=");
    if (equalsAt === -1) continue;
    if (FLOAT_LITERAL.test(code.slice(equalsAt))) {
      findings.push(`line ${lineIndex + 1}: ${line.trim()}`);
    }
  }
  return findings;
}

function parseGates(raw: unknown): GatesMilli {
  const gates = table(raw, "gates");
  const big = 1_000_000;
  return {
    wcagBodyTextMinMilli: integer(
      gates,
      "wcag_body_text_min_milli",
      "gates",
      1000,
      21000,
    ),
    wcagAaaMutedMinMilli: integer(
      gates,
      "wcag_aaa_muted_min_milli",
      "gates",
      1000,
      21000,
    ),
    wcagInteractiveMinMilli: integer(
      gates,
      "wcag_interactive_min_milli",
      "gates",
      1000,
      21000,
    ),
    crossStateDeltaE00MinMilli: integer(
      gates,
      "cross_state_delta_e00_min_milli",
      "gates",
      1,
      big,
    ),
    slaFreshStaleDeltaE00MinMilli: integer(
      gates,
      "sla_fresh_stale_delta_e00_min_milli",
      "gates",
      1,
      big,
    ),
    bitset32MaxBit: integer(gates, "bitset32_max_bit", "gates", 0, 30),
    keymapSlotCount: integer(gates, "keymap_slot_count", "gates", 1, 10),
  };
}

function parseBridges(raw: unknown): Bridge[] {
  const bridges = Object.entries(table(raw, "bridges")).map(([key, value]) => {
    const row = table(value, `bridges.${key}`);
    return {
      key,
      bridgeId: integer(row, "bridge_id", `bridges.${key}`, 0, 3),
      bridgeKey: text(row, "bridge_key", `bridges.${key}`),
    };
  });
  const ids = new Set(bridges.map((bridge) => bridge.bridgeId));
  if (bridges.length !== 4 || ids.size !== 4) {
    throw new TokensContractError(
      "ERR_TOKENS_BRIDGES_INCOMPLETE",
      `[bridges] must define each 2-bit id 0..3 exactly once, got ${[...ids].join(",")}`,
    );
  }
  return bridges.sort((left, right) => left.bridgeId - right.bridgeId);
}

function parseIngestion(
  raw: unknown,
  bridges: readonly Bridge[],
): IngestionChannel[] {
  const bridgeIdByKey = new Map(
    bridges.map((bridge) => [bridge.key, bridge.bridgeId]),
  );
  const seenIds = new Set<number>();
  const seenAliases = new Map<string, string>();
  const channels = Object.entries(table(raw, "ingestion")).map(
    ([key, value]) => {
      const context = `ingestion.${key}`;
      const row = table(value, context);
      const channelCode = text(row, "channel_code", context);
      const slaKind = text(row, "sla_kind", context);
      if (slaKind !== "latency" && slaKind !== "sentinel_drop") {
        throw new TokensContractError(
          "ERR_TOKENS_SHAPE",
          `${context}.sla_kind is ${slaKind}`,
        );
      }
      const channelId = integer(row, "channel_id", context, 0, 15);
      if (seenIds.has(channelId)) {
        throw new TokensContractError(
          "ERR_TOKENS_INGESTION_INCOMPLETE",
          `${context}.channel_id ${channelId} is not unique`,
        );
      }
      seenIds.add(channelId);
      const slaTensOfMs = integer(row, "sla_tens_of_ms", context, 0, 255);
      const expectedTens =
        slaKind === "latency"
          ? integer(row, "sla_ms", context, 10, 2550) / 10
          : 0;
      if (slaTensOfMs !== expectedTens) {
        throw new TokensContractError(
          "ERR_TOKENS_INGESTION_INCOMPLETE",
          `${context}.sla_tens_of_ms is ${slaTensOfMs}, expected ${expectedTens} (sla_kind ${slaKind})`,
        );
      }
      const bridgeKeys = stringList(row, "bridges", context);
      let bridgeMask4 = 0;
      for (const bridgeKey of bridgeKeys) {
        const bridgeId = bridgeIdByKey.get(bridgeKey);
        if (bridgeId === undefined) {
          throw new TokensContractError(
            "ERR_TOKENS_BRIDGES_INCOMPLETE",
            `${context}.bridges names undefined bridge ${bridgeKey}`,
          );
        }
        bridgeMask4 |= 1 << bridgeId;
      }
      const wireAliases = stringList(row, "wire_aliases", context);
      if (!wireAliases.includes(channelCode)) {
        throw new TokensContractError(
          "ERR_TOKENS_INGESTION_INCOMPLETE",
          `${context}.wire_aliases must include channel_code ${channelCode}`,
        );
      }
      for (const alias of wireAliases) {
        const owner = seenAliases.get(alias);
        if (owner !== undefined) {
          throw new TokensContractError(
            "ERR_TOKENS_INGESTION_INCOMPLETE",
            `wire alias ${alias} is claimed by ${owner} and ${key}`,
          );
        }
        seenAliases.set(alias, key);
      }
      return {
        key,
        layerId: text(row, "layer_id", context),
        tokenName: text(row, "token_name", context),
        hex: hex(row, "hex", context),
        channelCode,
        channelId,
        slaKind,
        slaTensOfMs,
        bridgeKeys,
        bridgeMask4,
        wireAliases,
      } satisfies IngestionChannel;
    },
  );
  return channels.sort((left, right) => left.channelId - right.channelId);
}

function parseSla(raw: unknown): SlaState[] {
  const sla = table(raw, "sla");
  const keys = Object.keys(sla);
  if (keys.length !== SLA_KEYS.length || !SLA_KEYS.every((key) => key in sla)) {
    throw new TokensContractError(
      "ERR_TOKENS_SLA_ORDER",
      `[sla] must define exactly ${SLA_KEYS.join(", ")}; got ${keys.join(", ")}`,
    );
  }
  let previousCeiling = 0;
  return SLA_KEYS.map((key, expectedRank) => {
    const context = `sla.${key}`;
    const row = table(sla[key], context);
    const rank = integer(row, "rank", context, 0, 3);
    if (rank !== expectedRank) {
      throw new TokensContractError(
        "ERR_TOKENS_SLA_ORDER",
        `${context}.rank must be ${expectedRank}, got ${rank}`,
      );
    }
    const isLast = expectedRank === SLA_KEYS.length - 1;
    let ageCeilingMilliSla: number | undefined;
    if (isLast) {
      if ("age_ceiling_milli_sla" in row) {
        throw new TokensContractError(
          "ERR_TOKENS_SLA_ORDER",
          `${context} is unbounded and must not set age_ceiling_milli_sla`,
        );
      }
    } else {
      ageCeilingMilliSla = integer(
        row,
        "age_ceiling_milli_sla",
        context,
        1,
        1_000_000,
      );
      if (ageCeilingMilliSla <= previousCeiling) {
        throw new TokensContractError(
          "ERR_TOKENS_SLA_ORDER",
          `${context}.age_ceiling_milli_sla must exceed ${previousCeiling}`,
        );
      }
      previousCeiling = ageCeilingMilliSla;
    }
    return {
      key,
      rank,
      tokenName: text(row, "token_name", context),
      hex: hex(row, "hex", context),
      ageCeilingMilliSla,
    };
  });
}

function parseBitFlags(
  raw: unknown,
  context: string,
  maxBit: number,
): BitFlag[] {
  const seenBits = new Map<number, string>();
  const flags = Object.entries(table(raw, context)).map(([name, value]) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > maxBit
    ) {
      throw new TokensContractError(
        "ERR_TOKENS_BITSET_RANGE",
        `${context}.${name} must be an integer bit index in [0, ${maxBit}], got ${JSON.stringify(value)}`,
      );
    }
    const owner = seenBits.get(value);
    if (owner !== undefined) {
      throw new TokensContractError(
        "ERR_TOKENS_BITSET_RANGE",
        `${context}.${name} reuses bit ${value} of ${owner}`,
      );
    }
    seenBits.set(value, name);
    return { name, bit: value };
  });
  if (flags.length === 0) {
    throw new TokensContractError(
      "ERR_TOKENS_BITSET_RANGE",
      `${context} is empty`,
    );
  }
  return flags.sort((left, right) => left.bit - right.bit);
}

function parseKeymap(
  raw: unknown,
  slotCount: number,
  uiStateFlags: readonly BitFlag[],
): KeymapSlot[] {
  const entries = Object.entries(table(raw, "keymap"));
  const slots = entries.map(([key, value]) => {
    const context = `keymap.${key}`;
    const row = table(value, context);
    return {
      key,
      slotIndex: integer(row, "slot_index", context, 0, slotCount - 1),
      keyCode: text(row, "key_code", context),
      mode: integer(row, "mode", context, 1, slotCount),
      modeId: text(row, "mode_id", context),
      uiStateFlag: text(row, "ui_state_flag", context),
    };
  });
  const loop = (message: string): never => {
    throw new TokensContractError("ERR_A11Y_FOCUS_TRAP_LOOP", message);
  };
  if (slots.length !== slotCount)
    loop(`[keymap] has ${slots.length} slots, expected ${slotCount}`);
  const flagNames = new Set(uiStateFlags.map((flag) => flag.name));
  const seen = {
    slot: new Set<number>(),
    key: new Set<string>(),
    mode: new Set<number>(),
    modeId: new Set<string>(),
    flag: new Set<string>(),
  };
  for (const slot of slots) {
    const expectedKey = `M${String(slot.slotIndex + 1).padStart(2, "0")}`;
    if (slot.key !== expectedKey)
      loop(
        `keymap.${slot.key} holds slot_index ${slot.slotIndex}; expected table ${expectedKey}`,
      );
    if (slot.keyCode !== KEY_CODES[slot.slotIndex])
      loop(
        `keymap.${slot.key}.key_code ${slot.keyCode} breaks slot ${slot.slotIndex} <-> ${KEY_CODES[slot.slotIndex]}`,
      );
    if (slot.mode !== slot.slotIndex + 1)
      loop(
        `keymap.${slot.key}.mode ${slot.mode} breaks slot ${slot.slotIndex} <-> mode ${slot.slotIndex + 1}`,
      );
    if (!flagNames.has(slot.uiStateFlag))
      loop(
        `keymap.${slot.key}.ui_state_flag ${slot.uiStateFlag} is not in [bitmasks.ui_state]`,
      );
    if (
      seen.slot.has(slot.slotIndex) ||
      seen.key.has(slot.keyCode) ||
      seen.mode.has(slot.mode) ||
      seen.modeId.has(slot.modeId) ||
      seen.flag.has(slot.uiStateFlag)
    ) {
      loop(
        `keymap.${slot.key} is not bijective (duplicate slot, key, mode, mode_id, or flag)`,
      );
    }
    seen.slot.add(slot.slotIndex);
    seen.key.add(slot.keyCode);
    seen.mode.add(slot.mode);
    seen.modeId.add(slot.modeId);
    seen.flag.add(slot.uiStateFlag);
  }
  return slots.sort((left, right) => left.slotIndex - right.slotIndex);
}

function parseTokenMap(raw: unknown): Map<string, string> {
  const entries = Object.entries(table(raw, "tokens"));
  const out = new Map<string, string>();
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new TokensContractError(
        "ERR_TOKENS_SHAPE",
        `tokens.${key} must be a string`,
      );
    }
    if (value.startsWith("#")) assertHexColor(value, `tokens.${key}`);
    out.set(key, value);
  }
  return out;
}

function assertParity(
  slots: readonly { tokenName: string; hex: string; context: string }[],
  tokenMap: ReadonlyMap<string, string>,
): void {
  for (const slot of slots) {
    const tokenKey =
      LEGACY_TOKEN_ALIASES[slot.tokenName] ?? slot.tokenName.replace(/^--/, "");
    const mapped = tokenMap.get(tokenKey);
    if (mapped !== slot.hex) {
      throw new TokensContractError(
        "ERR_TOKENS_HEX_PARITY",
        `${slot.context} ${slot.tokenName} = ${slot.hex} but [tokens]."${tokenKey}" = ${mapped ?? "(missing)"}`,
      );
    }
  }
  for (const legacy of REQUIRED_LEGACY_TOKEN_KEYS) {
    if (!tokenMap.has(legacy)) {
      throw new TokensContractError(
        "ERR_TOKENS_HEX_PARITY",
        `legacy alias [tokens]."${legacy}" must be retained`,
      );
    }
  }
}

export function parseTokensV13(tomlText: string): TokensV13 {
  const floats = findFloatLiterals(tomlText);
  if (floats.length > 0) {
    throw new TokensContractError(
      "ERR_TOKENS_FLOAT_FORBIDDEN",
      `IEEE-754 float literals in tokens.toml: ${floats.join("; ")}`,
    );
  }
  const root = table(Bun.TOML.parse(tomlText), "root");
  const meta = table(root.meta, "meta");
  const version = text(meta, "version", "meta");
  if (version !== TOKENS_SCHEMA_VERSION) {
    throw new TokensContractError(
      "ERR_TOKENS_VERSION",
      `meta.version is ${version}, generator speaks ${TOKENS_SCHEMA_VERSION}`,
    );
  }
  const gates = parseGates(root.gates);
  const surfaces = Object.entries(table(root.surfaces, "surfaces")).map(
    ([key, value]) => {
      const row = table(value, `surfaces.${key}`);
      return {
        key,
        tokenName: text(row, "token_name", `surfaces.${key}`),
        hex: hex(row, "hex", `surfaces.${key}`),
      };
    },
  );
  const ui = Object.entries(table(root.ui, "ui")).map(
    ([key, value]): UiSlot => {
      const row = table(value, `ui.${key}`);
      const role = text(row, "role", `ui.${key}`);
      if (role !== "surface" && role !== "border" && role !== "text") {
        throw new TokensContractError(
          "ERR_TOKENS_SHAPE",
          `ui.${key}.role is ${role}`,
        );
      }
      return {
        key,
        tokenName: text(row, "token_name", `ui.${key}`),
        hex: hex(row, "hex", `ui.${key}`),
        role,
      };
    },
  );
  for (const required of [
    "surface_card",
    "surface_hover",
    "surface_selected",
    "border_strong",
    "focus_ring",
  ]) {
    if (!ui.some((slot) => slot.key === required)) {
      throw new TokensContractError(
        "ERR_TOKENS_SHAPE",
        `ui.${required} interactive slot is missing`,
      );
    }
  }
  const bridges = parseBridges(root.bridges);
  const ingestion = parseIngestion(root.ingestion, bridges);
  const sla = parseSla(root.sla);
  const bitmasks = table(root.bitmasks, "bitmasks");
  const betLegFlags = parseBitFlags(
    bitmasks.bet_legs,
    "bitmasks.bet_legs",
    gates.bitset32MaxBit,
  );
  const uiStateFlags = parseBitFlags(
    bitmasks.ui_state,
    "bitmasks.ui_state",
    gates.bitset32MaxBit,
  );
  const keymap = parseKeymap(root.keymap, gates.keymapSlotCount, uiStateFlags);
  const tokenMap = parseTokenMap(root.tokens);
  assertParity(
    [
      ...surfaces.map((slot) => ({ ...slot, context: `surfaces.${slot.key}` })),
      ...ui.map((slot) => ({ ...slot, context: `ui.${slot.key}` })),
      ...sla.map((slot) => ({ ...slot, context: `sla.${slot.key}` })),
    ],
    tokenMap,
  );
  const emerald = ingestion.find(
    (channel) => channel.tokenName === "--sd-theme-emerald",
  );
  if (
    emerald !== undefined &&
    tokenMap.get("sd-theme-emerald") !== emerald.hex
  ) {
    throw new TokensContractError(
      "ERR_TOKENS_HEX_PARITY",
      `[tokens]."sd-theme-emerald" must equal ingestion.${emerald.key}.hex ${emerald.hex}`,
    );
  }
  const routes = table(root.routes, "routes");
  const shrinkage = Object.entries(routes).find(
    ([, value]) => isTable(value) && value.threshold_kind === "bayes_shrinkage",
  );
  if (shrinkage === undefined) {
    throw new TokensContractError(
      "ERR_TOKENS_SHAPE",
      "no bayes_shrinkage route",
    );
  }
  const tauStarBasisPoints = integer(
    table(shrinkage[1], `routes.${shrinkage[0]}`),
    "tau_star_basis_points",
    `routes.${shrinkage[0]}`,
    0,
    10_000,
  );
  return {
    version,
    gates,
    surfaces,
    ui,
    ingestion,
    bridges,
    sla,
    betLegFlags,
    uiStateFlags,
    keymap,
    tokenMap,
    tauStarBasisPoints,
  };
}
