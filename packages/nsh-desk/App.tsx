import {
  computed,
  ErrorBoundary,
  host,
  keymap,
  mount,
  View,
  type JSX,
} from "nsh";
import {
  DeskHeader,
  DiagnosticsPanel,
  ExposurePanel,
  KpisPanel,
  PANEL_TITLES,
  ScoreboardPanel,
  SignalsPanel,
} from "./components";
import { formatUsd } from "./desk_model";
import {
  createDeskStore,
  LEAGUE_FILTER_OPTIONS,
  type LeagueFilter,
} from "./store";
import {
  animateUserLayoutChange,
  bindDesktopShellMenu,
  DeskCommandDialog,
  DeskWorkspace,
  StateNotice,
  Surface,
  UiKitGalleryDialog,
  type CommandItem,
  type DockAreaRef,
} from "./ui";

export function RootErrorFallback(props: {
  error: unknown;
  onReset: () => void;
}): JSX.Element {
  const detail = () => {
    const err = props.error;
    return err instanceof Error ? err.message : String(err);
  };
  return (
    <Surface variant="panel" class="flex-1 justify-center p-6">
      <StateNotice
        kind="unavailable"
        title="Workspace render error"
        detail={detail()}
        actionLabel="Reload workspace"
        onAction={props.onReset}
      />
    </Surface>
  );
}

function DeskRootBody(props: {
  consumeForcedError: () => string | null;
}): JSX.Element {
  const forcedError = props.consumeForcedError();
  if (forcedError !== null) {
    throw new Error(forcedError);
  }
  const store = createDeskStore();
  let dockRef: DockAreaRef | undefined;

  if (!store.originInfo.ok) {
    return (
      <Surface variant="panel" class="flex-1 justify-center p-6">
        <StateNotice
          kind="unavailable"
          title="Desk origin configuration error"
          detail={store.originInfo.error}
        />
      </Surface>
    );
  }

  const resolvedOrigin = store.originInfo.resolved;

  const toggleLeftDock = () => {
    animateUserLayoutChange();
    dockRef?.toggleDock("left");
  };

  const toggleBottomDock = () => {
    animateUserLayoutChange();
    dockRef?.toggleDock("bottom");
  };

  const resetWorkspaceLayout = () => {
    animateUserLayoutChange();
    store.resetLayout();
  };

  const copyDiagnostics = () => {
    void store.copyDiagnosticsToClipboard();
  };

  const focusPanel = (panelId: string) => {
    if (panelId === "kpis" && !store.dockOpen().left) {
      animateUserLayoutChange();
      dockRef?.setDockOpen("left", true);
    } else if (panelId === "diagnostics" && !store.dockOpen().bottom) {
      animateUserLayoutChange();
      dockRef?.setDockOpen("bottom", true);
    }
    dockRef?.selectPanel(panelId);
  };

  const commandItems = computed<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: "cmd:refresh",
        label: "Refresh all :4020 endpoints",
        group: "Workspace",
        shortcut: "mod+r",
        keywords: ["poll", "reload", "fetch", "kpis", "kalshi"],
      },
      {
        id: "cmd:toggle-autopoll",
        label: "Auto refresh every 10 seconds",
        group: "Workspace",
        checked: store.autoPoll(),
        keywords: ["timer", "polling", "live"],
      },
      {
        id: "cmd:toggle-kpis",
        label: "Toggle KPIs & Provenance dock",
        group: "Workspace",
        shortcut: "mod+1",
        checked: store.dockOpen().left,
        keywords: ["left", "sidebar", "agents"],
      },
      {
        id: "cmd:toggle-pipeline",
        label: "Toggle Pipeline & Honesty dock",
        group: "Workspace",
        shortcut: "mod+2",
        checked: store.dockOpen().bottom,
        keywords: ["bottom", "r2", "diagnostics", "sinks"],
      },
      {
        id: "cmd:toggle-lock",
        label: "Lock workspace layout",
        group: "Workspace",
        shortcut: "mod+shift+l",
        checked: store.locked(),
        keywords: ["freeze", "dock"],
      },
      {
        id: "cmd:reset-layout",
        label: "Reset workspace layout",
        group: "Workspace",
        keywords: ["default", "restore", "panes"],
      },
      {
        id: "cmd:copy-diagnostics",
        label: "Copy diagnostics JSON to clipboard",
        group: "Workspace",
        shortcut: "mod+shift+c",
        keywords: ["export", "snapshot", "503"],
      },
      {
        id: "cmd:open-uikit",
        label: "Open Sportsdesk UI kit…",
        group: "Workspace",
        shortcut: "mod+u",
        keywords: ["gallery", "tokens", "components"],
      },
      {
        id: "panel:signals",
        label: "Focus panel: Kalshi Signals",
        group: "Panels",
        keywords: ["table", "edge", "markets"],
      },
      {
        id: "panel:exposure",
        label: "Focus panel: Exposure Plot",
        group: "Panels",
        keywords: ["chart", "bars", "risk"],
      },
      {
        id: "panel:scoreboard",
        label: "Focus panel: Scoreboard",
        group: "Panels",
        keywords: ["games", "scores"],
      },
      {
        id: "appearance:system",
        label: "Appearance: System",
        group: "Appearance",
        checked: store.appearance() === "system",
        keywords: ["theme", "auto"],
      },
      {
        id: "appearance:light",
        label: "Appearance: Light",
        group: "Appearance",
        checked: store.appearance() === "light",
        keywords: ["theme", "day"],
      },
      {
        id: "appearance:dark",
        label: "Appearance: Dark",
        group: "Appearance",
        checked: store.appearance() === "dark",
        keywords: ["theme", "night"],
      },
    ];

    for (const opt of LEAGUE_FILTER_OPTIONS) {
      items.push({
        id: `league:${opt.id}`,
        label: `Scoreboard filter: ${opt.label}`,
        group: "Scoreboard League",
        checked: store.leagueFilter() === opt.id,
        keywords: ["filter", "scoreboard", opt.id.toLowerCase()],
      });
    }

    const snap = store.kalshiSnap();
    if (snap.status === "ready") {
      const topSignals = store.plotPoints();
      for (const pt of topSignals) {
        items.push({
          id: `signal:${pt.signalId}`,
          label: `${pt.fullLabel} (${formatUsd(pt.riskUsd)} · ${pt.verdict})`,
          group: "Top Kalshi Signals",
          checked: store.selectedSignal()?.id === pt.signalId,
          keywords: [pt.signalId, pt.league, pt.verdict],
        });
      }
    }

    return items;
  });

  const executeCommand = (id: string) => {
    switch (id) {
      case "cmd:refresh":
        void store.refreshAll();
        return;
      case "cmd:toggle-autopoll":
        store.toggleAutoPoll();
        return;
      case "cmd:toggle-kpis":
        toggleLeftDock();
        return;
      case "cmd:toggle-pipeline":
        toggleBottomDock();
        return;
      case "cmd:toggle-lock":
        store.toggleLocked();
        return;
      case "cmd:reset-layout":
        resetWorkspaceLayout();
        return;
      case "cmd:copy-diagnostics":
        copyDiagnostics();
        return;
      case "cmd:open-uikit":
        store.setUiKitOpen(true);
        return;
      case "panel:signals":
        focusPanel("signals");
        return;
      case "panel:exposure":
        focusPanel("exposure");
        return;
      case "panel:scoreboard":
        focusPanel("scoreboard");
        return;
      case "appearance:system":
        store.setAppearance("system");
        return;
      case "appearance:light":
        store.setAppearance("light");
        return;
      case "appearance:dark":
        store.setAppearance("dark");
        return;
    }

    if (id.startsWith("league:")) {
      const nextLeague = id.slice("league:".length) as LeagueFilter;
      store.setLeagueFilter(nextLeague);
      focusPanel("scoreboard");
      return;
    }

    if (id.startsWith("signal:")) {
      const sigId = id.slice("signal:".length);
      store.selectSignalById(sigId);
      focusPanel("signals");
    }
  };

  keymap.bind({
    "mod+k": () => store.setCommandOpen(true),
    "mod+r": () => {
      void store.refreshAll();
    },
    "mod+1": toggleLeftDock,
    "mod+2": toggleBottomDock,
    "mod+shift+l": () => store.toggleLocked(),
    "mod+shift+c": copyDiagnostics,
    "mod+u": () => store.setUiKitOpen(true),
  });

  bindDesktopShellMenu({
    windowTitle: () => `Sportsdesk Desk — ${resolvedOrigin.origin}`,
    autoPoll: store.autoPoll,
    locked: store.locked,
    leftOpen: () => store.dockOpen().left,
    bottomOpen: () => store.dockOpen().bottom,
    appearance: store.appearance,
    onRefresh: () => {
      void store.refreshAll();
    },
    onToggleAutoPoll: () => store.toggleAutoPoll(),
    onToggleLeftDock: toggleLeftDock,
    onToggleBottomDock: toggleBottomDock,
    onToggleLocked: () => store.toggleLocked(),
    onResetLayout: resetWorkspaceLayout,
    onSetAppearance: (next) => store.setAppearance(next),
    onOpenCommandPalette: () => store.setCommandOpen(true),
    onCopyDiagnostics: copyDiagnostics,
    onOpenUiKit: () => store.setUiKitOpen(true),
  });

  return (
    <View class="min-h-0 flex-1">
      <DeskHeader
        store={store}
        origin={resolvedOrigin}
        onToggleLeftDock={toggleLeftDock}
        onToggleBottomDock={toggleBottomDock}
        onResetLayout={resetWorkspaceLayout}
        onCopyDiagnostics={copyDiagnostics}
      />

      <DeskWorkspace
        onRef={(r) => {
          dockRef = r;
        }}
        layout={store.layout()}
        locked={store.locked()}
        panelTitles={PANEL_TITLES}
        onLayoutChange={(next) => store.setLayout(next)}
        onDockOpenChange={(placement, open) =>
          store.setDockOpenPlacement(placement, open)
        }
        renderPanel={(panelId) => {
          switch (panelId) {
            case "signals":
              return <SignalsPanel store={store} />;
            case "exposure":
              return <ExposurePanel store={store} />;
            case "scoreboard":
              return <ScoreboardPanel store={store} />;
            case "kpis":
              return <KpisPanel store={store} />;
            case "diagnostics":
              return <DiagnosticsPanel store={store} />;
            default:
              return (
                <StateNotice
                  kind="empty"
                  title="Unknown panel"
                  detail={`Panel '${panelId}' is not registered.`}
                />
              );
          }
        }}
      />

      <DeskCommandDialog
        open={store.commandOpen()}
        items={commandItems()}
        onOpenChange={(open) => store.setCommandOpen(open)}
        onSelect={executeCommand}
      />

      <UiKitGalleryDialog
        open={store.uiKitOpen()}
        appearance={store.appearance()}
        onAppearanceChange={(next) => store.setAppearance(next)}
        onOpenChange={(open) => store.setUiKitOpen(open)}
      />
    </View>
  );
}

export function App(): JSX.Element {
  let forcedCrashConsumed = false;
  const consumeForcedError = (): string | null => {
    if (forcedCrashConsumed) return null;
    const raw = host.params["__testForceRenderError"];
    if (typeof raw === "string" && raw.length > 0) {
      forcedCrashConsumed = true;
      return raw;
    }
    return null;
  };

  return (
    <View class="flex-1 bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <ErrorBoundary
        fallback={(error, reset) => (
          <RootErrorFallback error={error} onReset={reset} />
        )}
      >
        <DeskRootBody consumeForcedError={consumeForcedError} />
      </ErrorBoundary>
    </View>
  );
}

mount(App);
