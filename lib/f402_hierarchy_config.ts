/**
 * Bun.env knobs for hierarchy capture (`getListAgenstByAgent`).
 * Default: do not retain full `PLAYERS` (57k+ rows with plaintext passwords).
 */

export type PlayersMode = "off" | "projected" | "full";

export function readPlayersMode(
  raw: string | undefined = Bun.env.F402_PLAYERS_MODE,
): PlayersMode {
  const v = (raw ?? "off").trim().toLowerCase();
  if (v === "off" || v === "projected" || v === "full") return v;
  throw new Error(
    `F402_PLAYERS_MODE must be off|projected|full (got ${JSON.stringify(raw)})`,
  );
}

export const PLAYERS_MODE = readPlayersMode();

export const PROBE_HOST = (
  Bun.env.F402_PROBE_HOST ??
  Bun.env.F402_BASE_URL ??
  "https://www.fantasy402.com"
).replace(/\/$/, "");

export const MANAGER_RRO = Number(Bun.env.F402_RRO ?? Bun.env.RRO ?? 1);

/** Query bust for live fetches; drift logging uses manifest SHA-256 (see `recordBustDrift`). */
export const PINNED_MANAGER_BUST = Bun.env.F402_PINNED_MANAGER_BUST ?? "1.0.280";

export const CAPTURE_LOG_PATH =
  Bun.env.F402_CAPTURE_LOG?.trim() || "";

export const AUDIT_DB_PATH = Bun.env.F402_AUDIT_DB?.trim() || "";
