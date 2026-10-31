# 📊 Cross-Market Parlay Matching & Phase 6C Real-Time Surveillance Architecture

## 1. Canonicalization & Identity Engine (`lib/combo_identity.ts`)
- [x] **Pure Identity Hashing**
  - [x] Order-independent sorting on all 6 fields (`[A, B]` = `[B, A]`).
  - [x] `identity_sha256` created via `Bun.CryptoHasher("sha256")`.
  - [x] Denormalized `shape_sha256` (ignores line deltas) and `pick_shape_sha256` (ignores `product_class` for pick-service detection via single-pass `DEDUP_THEN_LEAD` CTE).
- [x] **LineHundredths Integer Precision (`-50` to `+50` Slider)**
  - [x] All spreads and totals represented strictly as integer hundredths (`-3.25` → `-325`, `48.0` → `4800`).
  - [x] Dashboard slider colored semantically: `-50 to -1` (**Green** = Internal F402 better line), `0` (**White/Neutral**), `+1 to +50` (**Red** = Polymarket better line / Layoff Risk).
- [x] **DGS Alternate Spread Child Rotation Normalization (`GameNum + 5000`)**
  - [x] Maps synthetic DGS alternate rotation numbers (`5501..5999`) back to `parentGameNum = gameNum - 5000`.
  - [x] Indexes the In-Memory Board Cache by composite line-inclusive key `${canonicalGameId}:${periodLabel}:${subType}:${lineHundredths}` so main lines (`-350`) never overwrite alternate rungs (`-750`, `-1050`).

## 2. NBA 3-Bucket Routing, `1H/2H/1Q–4Q` Dynamic Period Pricer & Alt-Spread Ring
- [x] **`FULL_GAME_CLOB` (`57.3%` / `$1,103,500`)**: Routed to Polymarket CLOB via 4-slice 45s TWAP (`<= 2.0c` slippage cap), 6-wallet ephemeral HD burner rotation (`0xB1..0xB6`), and Polygon FastLane `bor_sendRawBundle` MEV Shield (`0%` mempool exposure, saving `$695.74` per `$42K` TWAP).
- [x] **`PERIOD_SYNTHETIC` (`26.4%` / `$509,000`) + `ALT_SPREADS` (`$148,500` — `$657,500` Combined)**:
  - `1H` (`$218,000` / `412` tix): Pace Multiplier (`1.028x` on fast transition matchups like `IND/SAC` → `126.5` fair total).
  - `2H` (`$112,400` / `245` tix): Halftime Rubber-Band Regression Scalar (`+0.12pt` per pt `> 12` at halftime).
  - `1Q` (`$77,000` / `168` tix): Starter Efficiency Scale (`1Q_Total_Scale = 25.8%`, anchored via Shadow Portfolio `SHD_NBA_01`).
  - `2Q` (`$28,400` / `64` tix): Non-Jokić Bench Rotation Drag (`Q2_BENCH_ROTATION_DRAG = 0.232` on `DEN/PHX`).
  - `3Q` (`$54,000` / `98` tix): Golden State Third-Quarter Starter Surge (`Q3_STARTER_SURGE_OFFSET = +1.15pt` on `GSW/SAC`).
  - `4Q` (`$19,200` / `47` tix): Clutch Half-Court Variance Compression (`sigma_4Q = 5.4 pts`).
  - `ALT_SPREADS` (`$148,500` / `312` tix, `$42K` on `NBA_LAL_BOS` `-7.5 / -10.5`): Guarded by continuous Gaussian/Probit Tail Correlation (`evaluateAltSpreadTjsCorrelation`), unconditionally blocking same-team Alt-Spread + ML/Main-Spread subset parlays (`BLOCKED_ALT_ML_SUBSET_TRAP`, `ρ = 0.593–0.784`).
- [x] **`LIVE_0G_RFQ` (`16.2%` / `$312,000`)**: Joined via `M.G<id>` to GS Partner 118 with a `3,000ms` Volatility Circuit Breaker and Halt-State IOC Delta-Drift catch-up.

## 3. Phase 6C Sub-500ms WebSocket Shadow Portfolio Syncer & 180s Quarantine Auto-Resolver
- [x] **Sub-500ms Dual-Path WebSocket Stream (Replaces 60s Cron Polling)**
  - Path A: Polymarket CLOB WebSocket (`wss://ws-subscriptions-clob.polymarket.com/ws/market`, `~112ms–118ms` ingest).
  - Path B: Polygon FastLane `eth_subscribe("logs")` on CTF Exchange `OrderFilled` (`~164ms` ingest).
  - Total end-to-end execution (`WSS + 4-Way Intent Classifier + F402 HTTP/2 updateByColumn`): **`334ms–394ms`** (`152x–179x` faster than 60s cron), stepping `CFB_TXST_ULL +14.5 → +13.0` (`345ms`) and `NFL_KC_BUF -1.5 → -2.5` (`394ms`) behind a `-125/-125` Vig Curtain.
- [x] **Autonomous 180-Second State-Machine `Quarantine_Auto_Resolver`**
  - **Branch 1 (`SCALP_EXIT_REVERT` `< 180s`)**: Un-quarantined `SHD_NBA_06_TRAP` (`DEN/PHX Under 223.5`) at `T+112s` after `AT10359` sold `$30K` of its `$34.5K` position at a scratch loss and PM reverted to `51.4c`.
  - **Branch 2 (`TRUE_STEAM_CONFIRMED` `@ 180s`)**: Promoted `PHI/MIL -4.5 → -6.0` after PM held `57.2c` for 180s AND Pinnacle moved `-1.5pt`.
  - **Branch 3 (`ISOLATED_ILLIQUID_SHADE` `@ 180s`)**: Un-quarantined `SAC/NOP 1H U116.5` with Asymmetric Vig Shade (`-125/+105`) and `$2,500` half-limit.

## 4. Ring-Fenced `Siloed_Capital_Allocator` ($250,000 Total Desk Treasury)
- [x] **Silo 1 — Core Matched-Book Hedge Vault (`60%` = `$150,000`)**: NBA Full-Game CLOB (`$82.5K`) + NFL/CFB Middles (`$67.5K`). Exclusive access to the `$70,000` Wintermute/GSR `640ms` JIT Credit Revolver.
- [x] **Silo 2 — Period Synthetic & Live 0G-RFQ Reserve (`25%` = `$62,500`)**: Ring-fenced for `1H/2H/1Q–4Q`, `ALT_SPREADS`, and cross-book SOR overflow (`JITRevolverAccess = STRICTLY_FORBIDDEN`).
- [x] **Silo 3 — Shadow Portfolio Mirror Sub-Wallet (`15% Hard Cap` = `$37,500`, `0xShadowSub..99A1`)**: Non-JIT sub-wallet (`JITRevolverAccess = STRICTLY_FORBIDDEN`) with per-sport sub-caps: NBA `50%` (`$18,750`), NFL/CFB `40%` (`$15,000`), and Tennis/MLB/NHL `10%` (`$3,750` hard clamp).

## 5. Dedicated Domain Routes & Zero-Friction DX (`./bin/dx`)
- **Cloudflare R2 Public Edge:** `https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/graph.html` (published via `scripts/publish_r2_graph.mjs` & `./bin/dx deploy`)
- **Cloudflare Pages Portal:** `https://fantasy402-docs-4ay.pages.dev/graph.html` (`docs/graph.html` + `docs/graph.js`)
- **SportsDesk Bun Webview Server:** `https://desk.bookdeskops.com/graph` (and `/surveillance-graph` in `sportsdesk_webview_server.ts`)
