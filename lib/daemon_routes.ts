/**
 * The daemon's routes, as data.
 *
 * `services/sportsdesk_webview_server.ts` dispatches through a chain of `pathname === "…"`
 * comparisons. The chain is the implementation; this table is the surface, so the docs side
 * (ledger members, spec paths) can be compared against something stable instead of grepping the
 * source on every pass.
 *
 * tests/daemon_routes.test.ts proves the two agree in both directions: a path in this table that
 * the daemon does not serve fails, and so does a served path that is missing here.
 *
 * Two columns earn their place by being *measured*, not assumed:
 *
 * - `guard` names the mechanism, and there are exactly four: `admin` (one policy block over
 *   `/api/watchlist` and the `/api/telegram/` prefix → 401, or 503 when no token is set),
 *   `pii` (loopback allowed, other peers need the admin token), `telegram-secret` (the webhook
 *   checks its own header) and `none`. A per-route scan of arm bodies said `none` for the
 *   telegram endpoints because the gate sits above them; the running server returned 503. Do not
 *   reintroduce a label for a guard that lives outside this process — a `proxy-auth` row would
 *   assert protection the daemon does not have, and `/live-bets`, `/status` and `/miniapp`
 *   answer 200 to a wrong bearer today.
 * - `method` is `ANY` where the daemon does not check `req.method`, rather than the method a
 *   client happens to use.
 *
 * `surface` is the ledger surface that owns the path, or null where no surface declares it yet.
 */
export type DaemonRoute = {
  readonly path: string;
  readonly method: "ANY" | "GET" | "POST";
  readonly guard: "none" | "admin" | "pii" | "telegram-secret";
  readonly surface: string | null;
};

export const DAEMON_ROUTES: readonly DaemonRoute[] = [
  {
    path: "/",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-dashboard",
  },
  {
    path: "/api/agent-tree",
    method: "ANY",
    guard: "pii",
    surface: "surface.daemon-agent-tree",
  },
  {
    path: "/api/agents/search",
    method: "ANY",
    guard: "pii",
    surface: "surface.daemon-agent-search",
  },
  {
    path: "/api/analysis",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-analysis",
  },
  {
    path: "/api/analysis/filters",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-analysis",
  },
  {
    path: "/api/analysis/reports",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-analysis",
  },
  {
    path: "/api/contests",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-contests",
  },
  {
    path: "/api/f402/get-pending",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-live-bets",
  },
  {
    path: "/api/game-admin",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-game-admin",
  },
  {
    path: "/api/game-admin/board",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-game-admin-board",
  },
  {
    path: "/api/graph-feed",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-graph-data-plane",
  },
  {
    path: "/api/live-bets",
    method: "ANY",
    guard: "pii",
    surface: "surface.daemon-live-bets",
  },
  {
    path: "/api/live-bets/summary",
    method: "ANY",
    guard: "pii",
    surface: "surface.daemon-live-bets",
  },
  {
    path: "/api/live-wagers",
    method: "ANY",
    guard: "pii",
    surface: "surface.daemon-live-wagers",
  },
  {
    path: "/api/parse-formdata",
    method: "POST",
    guard: "none",
    surface: "surface.daemon-dashboard",
  },
  {
    path: "/api/scoreboard",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-scoreboard",
  },
  {
    path: "/api/sports",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-sports-taxonomy",
  },
  {
    path: "/api/sports/catalog",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-sport-catalog",
  },
  {
    path: "/api/status",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-dashboard",
  },
  {
    path: "/api/telegram/activity",
    method: "GET",
    guard: "admin",
    surface: "surface.daemon-telegram-admin-routes",
  },
  {
    path: "/api/telegram/alert",
    method: "POST",
    guard: "admin",
    surface: "surface.daemon-telegram-admin-routes",
  },
  {
    path: "/api/telegram/report",
    method: "POST",
    guard: "admin",
    surface: "surface.daemon-telegram-admin-routes",
  },
  {
    path: "/api/telegram/status",
    method: "GET",
    guard: "admin",
    surface: "surface.daemon-telegram-admin-routes",
  },
  {
    path: "/api/telegram/webhook",
    method: "POST",
    guard: "admin",
    surface: "surface.daemon-telegram-admin-routes",
  },
  {
    path: "/api/test/error",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-telegram-admin-routes",
  },
  {
    path: "/api/watchlist",
    method: "ANY",
    guard: "admin",
    surface: "surface.daemon-telegram-admin-routes",
  },
  {
    path: "/dashboard",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-dashboard",
  },
  {
    path: "/graph",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/graph-live-feed.json",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-graph-data-plane",
  },
  {
    path: "/graph.html",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/graph.js",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/graph/",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/health",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/live-bets",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/live-bets/summary",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/miniapp",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-miniapp",
  },
  {
    path: "/miniapp/",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-miniapp",
  },
  {
    path: "/status",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-dashboard",
  },
  {
    path: "/status.json",
    method: "ANY",
    guard: "none",
    surface: "surface.daemon-dashboard",
  },
  {
    path: "/status/",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/surveillance-graph",
    method: "ANY",
    guard: "none",
    surface: null,
  },
  {
    path: "/telegram/webhook",
    method: "POST",
    guard: "telegram-secret",
    surface: "surface.daemon-telegram-admin-routes",
  },
];

/** Paths only, for the surface comparison. */
export const DAEMON_PATHS: readonly string[] = DAEMON_ROUTES.map(
  (route) => route.path,
);
