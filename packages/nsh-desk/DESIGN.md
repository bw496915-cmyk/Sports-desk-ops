# Sportsdesk Desk (`ops.sportsdesk.desk`) — Design & Motion Specification

Normative product design document for `packages/nsh-desk`, grounded in canonical `longbridge/nsh`
`v0.4.0` (`minRuntime: "0.4.0"`), `nsh-design-guides` ("Start from the task", "Establish the app's
design system first", and "Motion inventory"), and `nsh` TSX/Coding Guides.

## 1. Task, Objects, and Scope ("Start from the task")

- **Primary task:** Monitor Kalshi market signals, top-risk exposure concentration, KPI provenance,
  and R2 pipeline freshness against a read-only Sportsdesk `:4020` daemon with zero silent zeroes or
  disguised stale windows.
- **Primary objects:**
  1. **Kalshi signals** (`/api/signals/kalshi`) — sortable by risk, account count, fair probability,
     edge, and confidence with controlled row selection synced to an account-level breakdown and a
     ranked top-exposure bar chart (`DeskExposurePlot`).
  2. **KPIs & provenance** (`/api/kpis`) — headline desk metrics paired with explicit `[LIVE]`,
     `[STALE]`, `[PENDING]`, or `[FIXTURE]` provenance badges.
  3. **Pipeline & honesty telemetry** (`/api/kpis` R2 sinks + `:4020` endpoint statuses, including
     `/api/live-bets/summary`) — separating R2 object publish age from `#78` data-window age
     (`[DATA-STALE]`) and surfacing `503 [unauthorized]` causes verbatim.
  4. **Scoreboard** (`/api/scoreboard`) — league-filtered matchup states and scores.
- **Immediate vs secondary actions:**
  - **Primary toolbar (`Toolbar`):** `Refresh` (`mod+r`), `Auto 10s` immediate setting (`DeskSwitch`),
    dock visibility toggles (`KPIs`, `Pipeline`), `Command` palette trigger (`mod+k`), and
    `Workspace` command `Menu`.
  - **Command palette (`mod+k`, `DeskCommandDialog` on `nsh/base` `Command`):** Fuzzy-searchable
    operator palette for workspace commands, panel focus (`DockAreaRef.selectPanel`), appearance
    modes, league filters, and jumping directly to live Kalshi signals.
  - **Secondary commands (`Workspace` `Menu` + `nsh/desktop` application menu):** `Command palette…`
    (`mod+k`), `Lock layout` (`mod+shift+l`), `Reset layout`, `Copy diagnostics JSON` (`mod+shift+c`,
    writes a signal-honest JSON snapshot via `Clipboard.writeText`), synced radio appearance override
    (`System`, `Light`, `Dark`), and `UI kit…` (`mod+u`, opens the `ui/` component showcase dialog).
  - **Persisted operator preferences (`Storage`):** `leagueFilter`, `autoPoll`, `locked`, and dock
    open/close state hydrate from and persist to `Storage` under `ops.sportsdesk.desk.prefs.v1`;
    appearance preference (`system` | `light` | `dark`) hydrates from and persists under
    `ops.sportsdesk.desk.appearance.v1` as a single store-owned source of truth across menus and UI kit.
- **Empty, loading, unavailable, and read-only states:**
  - Every panel renders explicit `loading`, `empty`, and `unavailable` states via `StateNotice`
    (stating HTTP status, diagnostic code, verbatim cause, and recovery command `Refresh`).
  - Subsequent refreshes keep current rows on screen while `Refresh` reports busy state; panels
    never flash blank during background 10s polling.
  - Strictly read-only (`GET` only against `127.0.0.1` / `localhost`).

## 2. Supported Platform Targets

- **Desktop & Web (`platform.desktop === true`):**
  - Compact 28pt (`sm`) toolbar controls, 28pt dense `DataTable` rows with controlled row selection
    and `headerCellSorted` highlight, themed `<Tooltip>` hover hints (`DeskTooltip`) with shortcut
    badges, outward `focus-visible:` rings (including keyboard-focusable `Plot`), `Toolbar` arrow-key
    roving focus, `Tabs` roving focus, `keymap` shortcuts (`mod+k`, `mod+r`, `mod+1`, `mod+2`,
    `mod+shift+l`, `mod+shift+c`, `mod+u`), themed `ScrollbarTheme` (`DESK_SCROLLBAR_THEME`), and
    macOS menu bar integration (`Menu.setApplicationMenu`).
- **Mobile (`!platform.desktop`, iOS / Android / narrow viewport `< 600pt`):**
  - `DockArea` compact mode presents left/bottom docks as edge drawers and bottom sheets over a
    scrim backdrop; `SignalsPanel` pins only the compact `Lg` column (`68pt`) on narrow screens so
    horizontal scrolling stays uncramped; `DeskButton` and `DeskSwitch` expand touch hit targets
    (`min-h-11` + `hitSlop`) to satisfy 44pt / 48dp minimums.
- **TUI:** Not targeted (`ops.sportsdesk.desk` relies on graphical `DataTable` and `Plot` views).

## 3. Visual System, Scales, and Semantic Theme Tokens (`theme.json`)

All presentation colors resolve through `theme.json` tokens (`nsh.json` `"theme": "theme.json"`).
Raw hex, `rgb()`, `hsl()`, and Tailwind palette utilities (`red-*`, `amber-*`, `green-*`, `zinc-*`)
are prohibited in TSX presentation code. Vector icons (`ui/Icon.tsx`) draw crisp `Path2D` strokes on
`<Canvas>` colored reactively via `token(...)` so zero raw color literals or platform-drifting
Unicode symbols are used.

- **Radius scale (concentric):**
  - `--radius-lg`: `8px` — outer cards, floating dialogs, command palette, compact sheets.
  - `--radius`: `6px` — default controls, popovers, menus, tables (`rounded-(--radius)`).
  - `--radius-sm`: `4px` — inset segments, tooltips, and compact badges inside `p-1` (`8 - 4 = 4`).
- **Typography scale (minimum 12pt for reading, <= 3 sizes & 2 weights per region):**
  - `text-base` (16pt, `font-semibold`, `font-mono tabular-nums`): primary KPI figures.
  - `text-sm` (14pt, `font-semibold` / `font-normal`): workspace title, dialog headings, empty-state titles.
  - `text-xs` (12pt, `font-medium` / `font-normal`): toolbar controls, tabs, dense table cells,
    unique rank/matchup plot axis labels, metadata (`text-muted-foreground`), and monospace
    identifiers (`font-mono tabular-nums`).
  - Zero sub-12pt literal sizes (`text-[10px]`, `text-[11px]` are forbidden).
- **Spacing grammar (4pt steps, Shared content spines):**
  - `gap-1` (4pt): parts of one control or title/subtitle pair.
  - `gap-1.5` / `gap-2` (6–8pt): related toolbar controls and compact rows.
  - `gap-3` (12pt): content groups inside a panel (`p-3` shared panel inset; `DESK_SCROLLBAR_THEME`
    stays on the `Scroll` outer viewport edge with `p-3` / `p-4` inside the scroll child).
- **Semantic status & chart tokens (light & dark balanced):**
  - `positive` / `positive-foreground`: verified `[LIVE]`, healthy R2 sinks, positive signal edge.
  - `warning` / `warning-foreground`: `[STALE]`, `[DATA-STALE]` (`#78`), degraded Kalshi, `503` auth notice.
  - `negative` / `negative-foreground` & `destructive`: negative signal edge and hard endpoint errors.
  - `chart-1` .. `chart-5`: ordinal league color scale on `DeskExposurePlot` bars.

## 4. Architecture, Root Component (`App.tsx`), `components/`, & `ui/` Layer

Following `https://nsh.dev/docs/project-structure/#the-root-component`, the package enforces an
acyclic module graph (`App.tsx` → `components/` → `store.ts` / `ui/` → `nsh/base`):

- **Root component (`App.tsx`):** Single `mount(App)` entry point owning the outer safe-area shell,
  root `<ErrorBoundary>` (`RootErrorFallback` with `Reload workspace` reset), `createDeskStore()`,
  `keymap.bind` (`mod+k`, `mod+r`, `mod+1`, `mod+2`, `mod+shift+l`, `mod+shift+c`, `mod+u`), desktop
  application menu binding, `DeskWorkspace` panel dispatch, `DeskCommandDialog`, and `UiKitGalleryDialog`.
- **Feature panels (`components/`):** `DeskHeader`, `SignalsPanel`, `ExposurePanel`,
  `ScoreboardPanel`, `KpisPanel`, `DiagnosticsPanel`, and `provenance.ts`. Feature modules
  (`App.tsx`, `components/*`, `store.ts`) import **only** `nsh` primitives (`View`, `Text`,
  `Scroll`, `ErrorBoundary`, `Storage`, `Clipboard`) and `./ui` components — never `nsh/base`
  directly and never `../App`:

- `ui/tokens.ts` — `ControlSize` (`xs` | `sm` | `md`), motion token classes, `DESK_SCROLLBAR_THEME`, `animateUserLayoutChange()`.
- `ui/Icon.tsx` — `DeskIcon` (`Canvas` + `Path2D` + `token(...)` vector icons: `check`, `chevron-down`, `refresh`, `search`, `command`, `close`, `copy`, `lock`).
- `ui/Tooltip.tsx` — `DeskTooltip` & `renderOptionalTooltip` (`nsh/base` `Tooltip` with popup surface, shortcut hint, and enter/exit transitions).
- `ui/Button.tsx` — `DeskButton` (`default`, `primary`, `outline`, `ghost`, `danger`, optional `icon`) & `DeskIconButton`.
- `ui/Switch.tsx` — `DeskSwitch` (`Switch` with styled track, sliding thumb, themed `Tooltip`, focus ring, touch slop).
- `ui/SegmentedTabs.tsx` — `SegmentedTabs` (`Tabs` + `Tab` with native spring-sliding `indicatorClass`).
- `ui/Menu.tsx` — `DeskMenu`, `DeskMenuItem` (persistent `checked:` vector check indicator + `menuitemradio` support), `DeskMenuSeparator`.
- `ui/Dialog.tsx` — `DeskDialog` (themed modal surface with `DESK_SCROLLBAR_THEME` and Escape/backdrop dismissal).
- `ui/CommandPalette.tsx` — `DeskCommandDialog` (`nsh/base` `Command` inside `Dialog` with `searchAccessibilityLabel`, section headers, shortcut badges, and checkmarks).
- `ui/Surface.tsx` — `Surface`, `Badge`, `SectionHeader`, `Separator`, `StateNotice`.
- `ui/DataView.tsx` — `DeskDataTable`, `DeskExposurePlot`, `DeskToolbar`, `DeskWorkspace`, `bindDesktopShellMenu`.
- `ui/UiKitGallery.tsx` — interactive gallery rendering every `ui/` component, icon, variant, size, and state synced with store appearance in Light and Dark modes.

## 5. Motion Tokens & Screen Motion Inventory

### Motion Tokens

| Token     | Value / Class               | Curve             | Purpose                                                        |
| --------- | --------------------------- | ----------------- | -------------------------------------------------------------- |
| `instant` | `100ms` (`duration-100`)    | `ease-out`        | Pointer hover washes, scrollbar thumb hover, border emphasis   |
| `fast`    | `150ms` (`duration-150`)    | `ease-out`        | Button press scale (`0.97`), switch thumb/track, popup/tooltip |
| `base`    | `200ms` (`duration-200`)    | `ease-in-out`     | Dialog fade, panel first-ready fade, user layout change        |
| `spring`  | Native `Tabs` `spring_move` | Critically damped | Sliding segmented selection indicator & `Plot` keyboard glide  |

### Motion Inventory (`ops.sportsdesk.desk`)

| #   | State Change Kind              | Concrete Screen Element                                                                                       | Tool & Motion Tokens                                                                                                                                                                                                          | `reduceMotion` Behavior                                                                         |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Press & hover on controls      | `DeskButton`, `DeskIconButton`, `DeskMenu` trigger, `Command` rows, `DockArea` tabs                           | `transition duration-100 ease-out` hover wash (`hover:bg-accent`); `active:scale-[0.97] duration-150` press settle; `Plot` `Bar` `inactiveOpacity={0.45}` hover dim                                                           | `motion-reduce:transition-none motion-reduce:active:scale-100`; `Plot` hover snaps immediately  |
| 2   | Glyph or label changing        | `Auto 10s` `DeskSwitch`; `Refresh` ↔ `Refreshing…`; `MenuItem` persistent check indicator; poll latency       | `DeskSwitch` thumb `transition-transform duration-150 checked:translate-x-3.5` + track `transition-colors duration-150`; `MenuItem` `indicatorClass` `opacity-0 checked:opacity-100`; poll latency counter uses **no motion** | `motion-reduce:transition-none` snaps switch thumb at once                                      |
| 3   | Selection that moves           | Scoreboard league `SegmentedTabs` (`ALL`/`NFL`/`NBA`/`NHL`/`NCAA`), UI kit preview tabs, `Plot` keyboard step | `nsh/base` `Tabs` single `indicatorClass` sliding natively via `spring_move`; `Plot` `crossLineClass` follows pointer 1:1 and glides on keyboard focus                                                                        | Native `Tabs` indicator and `Plot` crossline jump immediately when `reduceMotion` is on         |
| 4   | Content arriving or leaving    | Panel initial `loading` → `ready` content; `DataTable` sorted cells; `Scroll` built-in `DESK_SCROLLBAR_THEME` | Panel ready container plays one component-owned `createMotion({ enter: "fadeIn", duration: 150 })`; `DESK_SCROLLBAR_THEME` fades (`enter: 100`, `exit: 180`, `idle: 1400`); `DataTable` cells use **no motion**               | `createMotion` & `ScrollbarMotion` snap without animation when `reduceMotion()` is true         |
| 5   | Surface opening or closing     | `Workspace` `DeskMenu` popup; `DeskTooltip`; `DeskCommandDialog` (`mod+k`); `UI kit…` `DeskDialog`; drawers   | `Menu` & `Tooltip` `startingClass`/`endingClass` (`opacity-0 scale-95 -translate-y-1`) with `transition duration-150 ease-out`; `Dialog` `animation` switches `"fade"` vs `"none"`                                            | `motion-reduce:transition-none`; `Dialog` passes `animation={reduceMotion() ? "none" : "fade"}` |
| 6   | Layout changing by user action | `KPIs` dock toggle, `Pipeline` dock toggle, `Reset layout` command                                            | `animateUserLayoutChange()` calls `LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"))` prior to user state update (never on window resize)                                                | `if (reduceMotion()) return;` skips `LayoutAnimation` so panes jump cleanly                     |
| 7   | Drag, swipe, or throw released | `DockArea` split handles, tab drag-and-drop, compact sheet swipe-down                                         | Native `DockArea` 1:1 pointer tracking and sheet dismissal physics                                                                                                                                                            | Native instant settle under system reduced motion                                               |
| 8   | Loading & progress             | Initial endpoint fetch vs subsequent manual/auto refresh                                                      | Initial load renders calm `StateNotice` (`loading`); subsequent refreshes keep live data mounted while `Refresh` disables (`Refreshing…`) — no skeleton flash                                                                 | Identical calm behavior (no continuous spinner animation)                                       |
| 9   | Live / continuous & sound      | Auto-poll 10s tick; audio feedback                                                                            | **No continuous shader** and **no sound** — operator desk runs silently alongside live sports feeds; visual provenance badges carry state                                                                                     | Fully legible at rest and silent                                                                |
