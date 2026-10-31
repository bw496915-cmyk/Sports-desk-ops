/**
 * @file lib/combo_uniqueness.ts
 * @description CFB combo uniqueness: per-game distinct combos and wallets, seeded from public
 * CFB trades + the Polymarket leaderboard, with a TTL cache and an optional strict mode.
 *
 * Public APIs only. Combo discovery is user-anchored: there is no global CFB combo feed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CFB_SERIES_ID, GAMMA_API } from "./polymarket_combo.ts";

export const DEFAULT_CACHE_TTL_HOURS = 24;
const ELIGIBLE_LEG_TYPES = new Set(["moneyline", "spreads", "totals"]);

export interface ComboUniquenessOptions {
  readonly fetchImpl?: typeof fetch;
  readonly concurrency?: number;
  readonly cacheDir?: string;
  readonly cacheTtlHours?: number;
  readonly fresh?: boolean;
  readonly leaderboard?: boolean;
  readonly leaderboardLimit?: number;
  readonly walletFile?: string;
  readonly strictFullGame?: boolean;
  readonly seedTrades?: boolean;
  readonly maxSeedMarkets?: number;
  readonly perMarket?: number;
  readonly maxComboPages?: number;
  readonly limitGames?: number;
  readonly now?: number;
  readonly timeoutMs?: number;
  readonly gammaBase?: string;
  readonly dataBase?: string;
}

interface CacheFile {
  readonly schemaVersion: 1;
  readonly fetchedAtIso: string;
  readonly records: readonly unknown[];
}

export interface ComboGameStats {
  readonly gameSlug: string;
  readonly title: string;
  readonly volume24hr: number;
  readonly uniqueCombos: number;
  readonly uniqueWallets: number;
  readonly fullyWithinGame: number;
  readonly samples: readonly {
    readonly comboId: string;
    readonly wallet: string;
    readonly legs: number;
    readonly games: number;
  }[];
}

export interface ComboUniquenessReport {
  readonly strictFullGame: boolean;
  readonly games: readonly ComboGameStats[];
  readonly global: {
    readonly gamesWithActivity: number;
    readonly sumPerGameCombos: number;
    readonly sumPerGameWallets: number;
    readonly distinctCombos: number;
    readonly distinctWallets: number;
  };
  readonly walletsScanned: number;
  readonly comboRecords: number;
  readonly cache: { readonly hits: number; readonly misses: number; readonly ttlHours: number };
}

interface CfbGame {
  readonly slug: string;
  readonly title: string;
  readonly volume24hr: number;
  readonly conditionIds: readonly string[];
  readonly marketSlugs: readonly string[];
  readonly clobTokenIds: readonly string[];
}

interface NormalizedCombo {
  readonly comboId: string;
  readonly wallet: string;
  readonly gameSlugs: ReadonlySet<string>;
  readonly legKeys: readonly string[];
  readonly allLegsCfb: boolean;
  readonly allCfbLegsEligible: boolean;
  readonly fullyWithinGame: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => text(entry)).filter(Boolean);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => text(entry)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function getJson(url: string, options?: ComboUniquenessOptions): Promise<unknown> {
  const response = await (options?.fetchImpl ?? fetch)(url, {
    proxy: false,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000),
  } as RequestInit);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length || 1) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Loads CFB events and indexes their condition IDs, slugs and CLOB token IDs. */
export async function loadCfbGames(options?: ComboUniquenessOptions): Promise<CfbGame[]> {
  const limit = Math.min(Math.max(options?.limitGames ?? 50, 1), 100);
  const gamma = (options?.gammaBase ?? GAMMA_API).replace(/\/$/, "");
  const body = await getJson(
    `${gamma}/events?series_id=${CFB_SERIES_ID}&active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`,
    options,
  );
  if (!Array.isArray(body)) return [];
  return body
    .map((raw): CfbGame | null => {
      const event = asRecord(raw);
      if (event === null) return null;
      const slug = text(event.slug);
      if (slug === "") return null;
      const markets = Array.isArray(event.markets) ? event.markets : [];
      const conditionIds: string[] = [];
      const marketSlugs: string[] = [];
      const tokenIds: string[] = [];
      for (const candidate of markets) {
        const market = asRecord(candidate);
        if (market === null) continue;
        const conditionId = text(market.conditionId);
        if (conditionId !== "") conditionIds.push(conditionId.toLowerCase());
        const marketSlug = text(market.slug);
        if (marketSlug !== "") marketSlugs.push(marketSlug);
        tokenIds.push(...jsonArray(market.clobTokenIds));
      }
      return {
        slug,
        title: text(event.title),
        volume24hr: Number(event.volume24hr) || 0,
        conditionIds,
        marketSlugs,
        clobTokenIds: tokenIds,
      };
    })
    .filter((game): game is CfbGame => game !== null);
}

interface GameIndex {
  readonly byConditionId: Map<string, string>;
  readonly byMarketSlug: Map<string, string>;
  readonly byTokenId: Map<string, string>;
}

export function buildGameIndex(games: readonly CfbGame[]): GameIndex {
  const byConditionId = new Map<string, string>();
  const byMarketSlug = new Map<string, string>();
  const byTokenId = new Map<string, string>();
  for (const game of games) {
    for (const id of game.conditionIds) byConditionId.set(id, game.slug);
    for (const slug of game.marketSlugs) byMarketSlug.set(slug, game.slug);
    for (const token of game.clobTokenIds) byTokenId.set(token, game.slug);
  }
  return { byConditionId, byMarketSlug, byTokenId };
}

function legConditionIds(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const direct = text(leg.leg_condition_id) || text(leg.conditionId);
  if (direct !== "") out.push(direct.toLowerCase());
  const market = asRecord(leg.market);
  if (market !== null) {
    const nested = text(market.condition_id) || text(market.conditionId);
    if (nested !== "") out.push(nested.toLowerCase());
  }
  return out;
}

function legMarketSlugs(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const market = leg.market;
  if (typeof market === "string" && market !== "") out.push(market);
  const direct = text(leg.marketSlug);
  if (direct !== "") out.push(direct);
  const nested = asRecord(market);
  if (nested !== null) {
    const slug = text(nested.slug) || text(nested.market_slug);
    if (slug !== "") out.push(slug);
  }
  return out;
}

function legTokenIds(leg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const direct = text(leg.clobTokenId) || text(leg.tokenId);
  if (direct !== "") out.push(direct);
  return out;
}

function legMarketType(leg: Record<string, unknown>): string {
  const market = asRecord(leg.market);
  return (
    text(market?.sports_market_type) ||
    text(market?.sportsMarketType) ||
    text(leg.sports_market_type) ||
    text(leg.sportsMarketType) ||
    text(leg.market_type)
  ).toLowerCase();
}

function legKey(leg: Record<string, unknown>): string {
  return (
    text(leg.leg_condition_id) ||
    text(leg.conditionId) ||
    text(asRecord(leg.market)?.condition_id) ||
    text(asRecord(leg.market)?.conditionId) ||
    text(leg.clobTokenId) ||
    text(leg.tokenId) ||
    text(leg.marketSlug) ||
    (typeof leg.market === "string" ? leg.market : "") ||
    text(asRecord(leg.market)?.slug) ||
    text(asRecord(leg.market)?.market_slug) ||
    text(leg.symbol) ||
    JSON.stringify(leg)
  ).toLowerCase();
}

function attributeLeg(
  leg: Record<string, unknown>,
  index: GameIndex,
): { game: string | null; type: string } {
  for (const id of legConditionIds(leg)) {
    const game = index.byConditionId.get(id);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  for (const slug of legMarketSlugs(leg)) {
    const game = index.byMarketSlug.get(slug);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  for (const token of legTokenIds(leg)) {
    const game = index.byTokenId.get(token);
    if (game !== undefined) return { game, type: legMarketType(leg) };
  }
  return { game: null, type: legMarketType(leg) };
}

function normalizeCombo(
  raw: unknown,
  fallbackWallet: string,
  index: GameIndex,
): NormalizedCombo | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const legsRaw = Array.isArray(record.legs) ? record.legs : Array.isArray(record.components) ? record.components : [];
  if (legsRaw.length === 0) return null;
  const legs = legsRaw.map(asRecord).filter((leg): leg is Record<string, unknown> => leg !== null);
  if (legs.length === 0) return null;

  const games = new Set<string>();
  let attributed = 0;
  let eligible = true;
  for (const leg of legs) {
    const result = attributeLeg(leg, index);
    if (result.game === null) continue;
    attributed += 1;
    games.add(result.game);
    if (!ELIGIBLE_LEG_TYPES.has(result.type)) eligible = false;
  }
  if (games.size === 0) return null;

  const legKeys = legs.map(legKey).sort();
  const comboId = text(record.comboId) || text(record.id) || `sha256:${hashKeys(legKeys)}`;
  const wallet = (text(record.user) || text(record.wallet) || fallbackWallet).toLowerCase();
  return {
    comboId,
    wallet,
    gameSlugs: games,
    legKeys,
    allLegsCfb: attributed === legs.length,
    allCfbLegsEligible: eligible,
    fullyWithinGame: games.size === 1,
  };
}

function hashKeys(keys: readonly string[]): string {
  return new Bun.CryptoHasher("sha256").update(keys.join("|")).digest("hex");
}

/** Seeds wallets from public CFB trades (one request per sampled market). */
export async function seedWalletsFromTrades(
  games: readonly CfbGame[],
  options?: ComboUniquenessOptions,
): Promise<Set<string>> {
  const maxMarkets = options?.maxSeedMarkets ?? 60;
  const perMarket = options?.perMarket ?? 100;
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(/\/$/, "");
  const ids = [...new Set(games.flatMap((game) => game.conditionIds))].slice(0, maxMarkets);
  const wallets = new Set<string>();
  await mapLimit(ids, options?.concurrency ?? 6, async (conditionId) => {
    try {
      const body = await getJson(
        `${data}/trades?market=${encodeURIComponent(conditionId)}&limit=${perMarket}`,
        options,
      );
      if (!Array.isArray(body)) return;
      for (const raw of body) {
        const row = asRecord(raw);
        if (row === null) continue;
        const wallet =
          text(row.proxyWallet) || text(row.wallet) || text(row.maker) || text(row.taker) || text(row.user);
        if (/^0x[0-9a-fA-F]{40}$/.test(wallet)) wallets.add(wallet.toLowerCase());
      }
    } catch {
      // a market with no trades is normal
    }
  });
  return wallets;
}

/** Seeds wallets from the v2 leaderboard (week/month/all, PnL-sorted). */
export async function seedWalletsFromLeaderboard(
  options?: ComboUniquenessOptions,
): Promise<Set<string>> {
  const wallets = new Set<string>();
  const limit = options?.leaderboardLimit ?? 100;
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(/\/$/, "");
  for (const period of ["week", "month", "all"] as const) {
    try {
      const body = await getJson(
        `${data}/v2/leaderboard?time_period=${period}&sort_by=PNL&limit=${limit}`,
        options,
      );
      const rows = Array.isArray(asRecord(body)?.data) ? (asRecord(body)!.data as unknown[]) : [];
      for (const raw of rows) {
        const wallet = text(asRecord(raw)?.user_id);
        if (/^0x[0-9a-fA-F]{40}$/.test(wallet)) wallets.add(wallet.toLowerCase());
      }
    } catch {
      // leaderboard is a best-effort seed
    }
  }
  return wallets;
}

function cacheTtlMs(options?: ComboUniquenessOptions): number {
  const hours = options?.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS;
  return Math.max(0, hours) * 3_600_000;
}

async function readCache(
  path: string,
  options?: ComboUniquenessOptions,
): Promise<readonly unknown[] | null> {
  if (options?.fresh === true) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) return null;
    const fetchedAt = Date.parse(parsed.fetchedAtIso ?? "");
    if (!Number.isFinite(fetchedAt)) return null;
    const ttl = cacheTtlMs(options);
    if (ttl === 0) return null;
    if ((options?.now ?? Date.now()) - fetchedAt > ttl) return null;
    return parsed.records;
  } catch {
    return null;
  }
}

async function fetchCombosUncached(
  wallet: string,
  options?: ComboUniquenessOptions,
): Promise<unknown[]> {
  const maxPages = Math.max(1, options?.maxComboPages ?? 3);
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(/\/$/, "");
  const records: unknown[] = [];
  for (const path of ["/v2/activity/combos", "/v2/positions/combos"]) {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const suffix = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      try {
        const body = await getJson(
          `${data}${path}?user=${wallet}&limit=500${suffix}`,
          options,
        );
        const record = asRecord(body);
        const pageRows = Array.isArray(record?.data) ? (record.data as unknown[]) : [];
        records.push(...pageRows);
        const next = text(asRecord(record?.pagination)?.next_cursor);
        if (pageRows.length === 0 || next === "") break;
        cursor = next;
      } catch {
        break;
      }
    }
  }
  return records;
}

async function cachedCombos(
  wallet: string,
  options: ComboUniquenessOptions | undefined,
  stats: { hits: number; misses: number },
): Promise<unknown[]> {
  const dir = options?.cacheDir ?? "scratch/cfb-combo-cache";
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${wallet}.json`);
  const cached = await readCache(path, options);
  if (cached !== null) {
    stats.hits += 1;
    return [...cached];
  }
  stats.misses += 1;
  const records = await fetchCombosUncached(wallet, options);
  const payload: CacheFile = {
    schemaVersion: 1,
    fetchedAtIso: new Date(options?.now ?? Date.now()).toISOString(),
    records,
  };
  await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");
  return records;
}

export async function buildComboUniquenessReport(
  options?: ComboUniquenessOptions,
): Promise<ComboUniquenessReport> {
  const games = await loadCfbGames(options);
  const index = buildGameIndex(games);

  const wallets = new Set<string>();
  if (options?.leaderboard !== false) {
    for (const wallet of await seedWalletsFromLeaderboard(options)) wallets.add(wallet);
  }
  if (options?.seedTrades === true) {
    for (const wallet of await seedWalletsFromTrades(games, options)) wallets.add(wallet);
  }
  if (options?.walletFile !== undefined) {
    try {
      const file = await readFile(options.walletFile, "utf8");
      for (const candidate of file.split(/\s+/)) {
        if (/^0x[0-9a-fA-F]{40}$/.test(candidate)) wallets.add(candidate.toLowerCase());
      }
    } catch {
      // missing wallet file is not fatal
    }
  }

  const stats = { hits: 0, misses: 0 };
  const perWallet = await mapLimit([...wallets], options?.concurrency ?? 6, async (wallet) => {
    const records = await cachedCombos(wallet, options, stats);
    return records.map((record) => normalizeCombo(record, wallet, index)).filter(
      (combo): combo is NormalizedCombo => combo !== null,
    );
  });

  const strict = options?.strictFullGame === true;
  const normalized = perWallet.flat().filter(
    (combo) => !strict || (combo.fullyWithinGame && combo.allLegsCfb && combo.allCfbLegsEligible),
  );

  const seen = new Set<string>();
  const deduped: NormalizedCombo[] = [];
  for (const combo of normalized) {
    const key = `${combo.comboId}|${combo.wallet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(combo);
  }

  const byGame = new Map<string, { combos: Set<string>; wallets: Set<string>; full: number; samples: NormalizedCombo[] }>();
  for (const game of games) {
    byGame.set(game.slug, { combos: new Set(), wallets: new Set(), full: 0, samples: [] });
  }
  for (const combo of deduped) {
    for (const slug of combo.gameSlugs) {
      const bucket = byGame.get(slug);
      if (bucket === undefined) continue;
      bucket.combos.add(combo.comboId);
      bucket.wallets.add(combo.wallet);
      if (combo.fullyWithinGame) bucket.full += 1;
      if (bucket.samples.length < 3) bucket.samples.push(combo);
    }
  }

  const gamesReport: ComboGameStats[] = games
    .map((game) => {
      const bucket = byGame.get(game.slug)!;
      return {
        gameSlug: game.slug,
        title: game.title,
        volume24hr: game.volume24hr,
        uniqueCombos: bucket.combos.size,
        uniqueWallets: bucket.wallets.size,
        fullyWithinGame: bucket.full,
        samples: bucket.samples.map((combo) => ({
          comboId: combo.comboId,
          wallet: combo.wallet,
          legs: combo.legKeys.length,
          games: combo.gameSlugs.size,
        })),
      };
    })
    .sort((a, b) => b.volume24hr - a.volume24hr || a.gameSlug.localeCompare(b.gameSlug));

  const globalCombos = new Set(deduped.map((combo) => combo.comboId));
  const globalWallets = new Set(deduped.map((combo) => combo.wallet));
  const sumCombos = gamesReport.reduce((sum, game) => sum + game.uniqueCombos, 0);
  const sumWallets = gamesReport.reduce((sum, game) => sum + game.uniqueWallets, 0);

  return {
    strictFullGame: strict,
    games: gamesReport,
    global: {
      gamesWithActivity: gamesReport.filter((game) => game.uniqueCombos > 0).length,
      sumPerGameCombos: sumCombos,
      sumPerGameWallets: sumWallets,
      distinctCombos: globalCombos.size,
      distinctWallets: globalWallets.size,
    },
    walletsScanned: wallets.size,
    comboRecords: normalized.length,
    cache: { ...stats, ttlHours: options?.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS },
  };
}
