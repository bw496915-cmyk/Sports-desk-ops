export type UiRole = "surface" | "border" | "text";

export const ROUTE_THRESHOLD_KINDS = [
  "consensus_lag",
  "bayes_shrinkage",
  "liquidity_depth",
  "composite_risk_gate",
] as const;

export type RouteThresholdKind = (typeof ROUTE_THRESHOLD_KINDS)[number];

const UI_ROLES: readonly UiRole[] = ["surface", "border", "text"];

export type TokensMeta = {
  version: string;
  author?: string;
};

export type SurfaceToml = {
  layer_id: "SURFACE.DOM" | "SURFACE.CLI";
  token_name: string;
  hex: string;
  surface_name: string;
  role: string;
  viewport: string;
  protocol: string;
  color_depth: string;
};

export type IngestionSlaToml =
  | { sla_kind: "latency"; sla_ms: number }
  | { sla_kind: "sentinel_drop" };

export type IngestionChannelToml = {
  layer_id: string;
  token_name: string;
  hex: string;
  channel_code: string;
  signal_tier: string;
  transport_uri: string;
  channel_status: string;
  volume_rule: string;
  operational_role: string;
} & IngestionSlaToml;

export type RouteThresholdToml =
  | {
      threshold_kind: "consensus_lag";
      max_lag_ms: number;
    }
  | {
      threshold_kind: "bayes_shrinkage";
      tau_star: number;
      min_tickets: number;
    }
  | {
      threshold_kind: "liquidity_depth";
      min_depth_cents: number;
    }
  | {
      threshold_kind: "composite_risk_gate";
      min_toxicity_score: number;
      max_hold_rate_basis_points: number;
      max_deficit_cents: number;
    };

export type RouteToml = {
  layer_id: string;
  token_name: string;
  hex: string;
  route_name: string;
  move_flag: string;
  trigger_kind: string;
  mitigation_kind: string;
  operational_role: string;
} & RouteThresholdToml;

export type UiTokenToml = {
  token_name: string;
  hex: string;
  role: UiRole;
  description: string;
};

export type TokensSsot = {
  meta: TokensMeta;
  surfaces: SurfaceToml[];
  ingestion: IngestionChannelToml[];
  routes: RouteToml[];
  ui: UiTokenToml[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`[tokens_ssot] ${ctx}: missing or invalid string ${key}`);
  }
  return v;
}

function reqNumber(obj: Record<string, unknown>, key: string, ctx: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`[tokens_ssot] ${ctx}: missing or invalid number ${key}`);
  }
  return v;
}

function parseMeta(raw: unknown): TokensMeta {
  if (!isRecord(raw)) {
    throw new Error("[tokens_ssot] meta must be a table");
  }
  const version = reqString(raw, "version", "meta");
  if (typeof raw.author === "string") {
    return { version, author: raw.author };
  }
  return { version };
}

function parseSurface(key: string, raw: unknown): SurfaceToml {
  if (!isRecord(raw)) throw new Error(`[tokens_ssot] surfaces.${key}: expected table`);
  const layer_id = reqString(raw, "layer_id", `surfaces.${key}`);
  if (layer_id !== "SURFACE.DOM" && layer_id !== "SURFACE.CLI") {
    throw new Error(`[tokens_ssot] surfaces.${key}: unknown layer_id ${layer_id}`);
  }
  return {
    layer_id,
    token_name: reqString(raw, "token_name", `surfaces.${key}`),
    hex: reqString(raw, "hex", `surfaces.${key}`),
    surface_name: reqString(raw, "surface_name", `surfaces.${key}`),
    role: reqString(raw, "role", `surfaces.${key}`),
    viewport: reqString(raw, "viewport", `surfaces.${key}`),
    protocol: reqString(raw, "protocol", `surfaces.${key}`),
    color_depth: reqString(raw, "color_depth", `surfaces.${key}`),
  };
}

function parseIngestionSla(
  key: string,
  raw: Record<string, unknown>,
): IngestionSlaToml {
  const sla_kind = reqString(raw, "sla_kind", `ingestion.${key}`);
  if (sla_kind === "latency") {
    return { sla_kind: "latency", sla_ms: reqNumber(raw, "sla_ms", `ingestion.${key}`) };
  }
  if (sla_kind === "sentinel_drop") {
    return { sla_kind: "sentinel_drop" };
  }
  throw new Error(
    `[tokens_ssot] ingestion.${key}: unknown sla_kind ${JSON.stringify(sla_kind)}`,
  );
}

function parseIngestion(key: string, raw: unknown): IngestionChannelToml {
  if (!isRecord(raw)) throw new Error(`[tokens_ssot] ingestion.${key}: expected table`);
  const sla = parseIngestionSla(key, raw);
  const base = {
    layer_id: reqString(raw, "layer_id", `ingestion.${key}`),
    token_name: reqString(raw, "token_name", `ingestion.${key}`),
    hex: reqString(raw, "hex", `ingestion.${key}`),
    channel_code: reqString(raw, "channel_code", `ingestion.${key}`),
    signal_tier: reqString(raw, "signal_tier", `ingestion.${key}`),
    transport_uri: reqString(raw, "transport_uri", `ingestion.${key}`),
    channel_status: reqString(raw, "channel_status", `ingestion.${key}`),
    volume_rule: reqString(raw, "volume_rule", `ingestion.${key}`),
    operational_role: reqString(raw, "operational_role", `ingestion.${key}`),
  };
  return { ...base, ...sla };
}

function parseRouteThreshold(
  key: string,
  raw: Record<string, unknown>,
): RouteThresholdToml {
  const kind = reqString(raw, "threshold_kind", `routes.${key}`);
  if (!isRouteThresholdKind(kind)) {
    throw new Error(
      `[tokens_ssot] routes.${key}: unknown threshold_kind ${JSON.stringify(kind)}`,
    );
  }
  switch (kind) {
    case "consensus_lag":
      return {
        threshold_kind: kind,
        max_lag_ms: reqNumber(raw, "max_lag_ms", `routes.${key}`),
      };
    case "bayes_shrinkage":
      return {
        threshold_kind: kind,
        tau_star: reqNumber(raw, "tau_star", `routes.${key}`),
        min_tickets: reqNumber(raw, "min_tickets", `routes.${key}`),
      };
    case "liquidity_depth":
      return {
        threshold_kind: kind,
        min_depth_cents: reqNumber(raw, "min_depth_cents", `routes.${key}`),
      };
    case "composite_risk_gate":
      return {
        threshold_kind: kind,
        min_toxicity_score: reqNumber(raw, "min_toxicity_score", `routes.${key}`),
        max_hold_rate_basis_points: reqNumber(
          raw,
          "max_hold_rate_basis_points",
          `routes.${key}`,
        ),
        max_deficit_cents: reqNumber(raw, "max_deficit_cents", `routes.${key}`),
      };
  }
}

function isRouteThresholdKind(k: string): k is RouteThresholdKind {
  return (
    k === "consensus_lag" ||
    k === "bayes_shrinkage" ||
    k === "liquidity_depth" ||
    k === "composite_risk_gate"
  );
}

function parseRoute(key: string, raw: unknown): RouteToml {
  if (!isRecord(raw)) throw new Error(`[tokens_ssot] routes.${key}: expected table`);
  const threshold = parseRouteThreshold(key, raw);
  const base = {
    layer_id: reqString(raw, "layer_id", `routes.${key}`),
    token_name: reqString(raw, "token_name", `routes.${key}`),
    hex: reqString(raw, "hex", `routes.${key}`),
    route_name: reqString(raw, "route_name", `routes.${key}`),
    move_flag: reqString(raw, "move_flag", `routes.${key}`),
    trigger_kind: reqString(raw, "trigger_kind", `routes.${key}`),
    mitigation_kind: reqString(raw, "mitigation_kind", `routes.${key}`),
    operational_role: reqString(raw, "operational_role", `routes.${key}`),
  };
  return { ...base, ...threshold };
}

function parseUi(key: string, raw: unknown): UiTokenToml {
  if (!isRecord(raw)) throw new Error(`[tokens_ssot] ui.${key}: expected table`);
  const roleRaw = reqString(raw, "role", `ui.${key}`);
  if (!UI_ROLES.includes(roleRaw as UiRole)) {
    throw new Error(
      `[tokens_ssot] ui.${key}: role must be surface|border|text, got ${JSON.stringify(roleRaw)}`,
    );
  }
  return {
    token_name: reqString(raw, "token_name", `ui.${key}`),
    hex: reqString(raw, "hex", `ui.${key}`),
    role: roleRaw as UiRole,
    description: reqString(raw, "description", `ui.${key}`),
  };
}

function tableValues(
  section: string,
  raw: unknown,
): [string, unknown][] {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] ${section} must be a table`);
  }
  return Object.entries(raw);
}

export function parseTokensToml(tomlText: string): TokensSsot {
  const parsed: unknown = Bun.TOML.parse(tomlText);
  return parseTokensTomlFromParsed(parsed);
}

export function parseTokensTomlFromParsed(parsed: unknown): TokensSsot {
  if (!isRecord(parsed)) {
    throw new Error("[tokens_ssot] root must be a TOML table");
  }
  const meta = parseMeta(parsed.meta);
  const surfaces = tableValues("surfaces", parsed.surfaces).map(([k, v]) =>
    parseSurface(k, v),
  );
  const ingestion = tableValues("ingestion", parsed.ingestion).map(([k, v]) =>
    parseIngestion(k, v),
  );
  const routes = tableValues("routes", parsed.routes).map(([k, v]) =>
    parseRoute(k, v),
  );
  const ui = tableValues("ui", parsed.ui ?? {}).map(([k, v]) => parseUi(k, v));
  return { meta, surfaces, ingestion, routes, ui };
}

/** Row shape accepted by formatRouteThreshold (threshold fields only). */
export type RouteThresholdRow = RouteThresholdToml;
