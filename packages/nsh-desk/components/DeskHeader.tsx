import { Text, View, type JSX } from "nsh";
import type { ResolvedDeskOrigin } from "../desk_model";
import type { DeskStore } from "../store";
import {
  Badge,
  DeskButton,
  DeskMenu,
  DeskMenuItem,
  DeskMenuSeparator,
  DeskSwitch,
  DeskToolbar,
  DeskToolbarGroup,
  DeskToolbarSeparator,
} from "../ui";

export interface DeskHeaderProps {
  store: DeskStore;
  origin: ResolvedDeskOrigin;
  onToggleLeftDock: () => void;
  onToggleBottomDock: () => void;
  onResetLayout: () => void;
  onCopyDiagnostics: () => void;
}

export function DeskHeader(props: DeskHeaderProps): JSX.Element {
  return (
    <View class="flex-row flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2">
      <View class="flex-row flex-wrap items-baseline gap-2">
        <Text role="header" class="text-sm font-semibold text-card-foreground">
          Sportsdesk Desk
        </Text>
        <Text class="font-mono text-xs text-muted-foreground">
          {`${props.origin.origin} [${props.origin.source}]`}
        </Text>
        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
          {props.store.lastPollMs() === null
            ? "polling…"
            : `poll #${props.store.pollCount()} · ${props.store.lastPollMs()}ms`}
        </Text>
        <If when={props.store.copiedDiagnosticsBytes() !== null}>
          <Badge
            testID="diagnostics-copied-badge"
            label={`copied ${props.store.copiedDiagnosticsBytes() ?? 0}B`}
            tone="positive"
          />
        </If>
      </View>

      <DeskToolbar accessibilityLabel="Workspace controls">
        <DeskToolbarGroup accessibilityLabel="Polling">
          <DeskButton
            label={props.store.polling() ? "Refreshing…" : "Refresh"}
            icon="refresh"
            variant="default"
            loading={props.store.polling()}
            tooltip="Poll all :4020 endpoints"
            shortcutHint="mod+r"
            onPress={() => {
              void props.store.refreshAll();
            }}
          />
          <DeskSwitch
            label="Auto 10s"
            checked={props.store.autoPoll()}
            tooltip="Poll :4020 automatically every 10 seconds"
            onChange={(next) => props.store.setAutoPoll(next)}
          />
        </DeskToolbarGroup>

        <DeskToolbarSeparator />

        <DeskToolbarGroup accessibilityLabel="Docks">
          <DeskButton
            label="KPIs"
            variant="outline"
            selected={props.store.dockOpen().left}
            accessibilityLabel="KPIs dock"
            tooltip="Toggle KPIs & Provenance dock"
            shortcutHint="mod+1"
            onPress={props.onToggleLeftDock}
          />
          <DeskButton
            label="Pipeline"
            variant="outline"
            selected={props.store.dockOpen().bottom}
            accessibilityLabel="Pipeline dock"
            tooltip="Toggle Pipeline & Honesty dock"
            shortcutHint="mod+2"
            onPress={props.onToggleBottomDock}
          />
        </DeskToolbarGroup>

        <DeskToolbarSeparator />

        <DeskButton
          testID="open-command-palette"
          label="Command"
          icon="search"
          variant="outline"
          accessibilityLabel="Open command palette"
          tooltip="Search commands, panels, and signals"
          shortcutHint="mod+k"
          onPress={() => props.store.setCommandOpen(true)}
        />

        <DeskMenu label="Workspace" testID="workspace-menu">
          <DeskMenuItem
            testID="menu-command-palette"
            label="Command palette…"
            shortcut="mod+k"
            onSelect={() => props.store.setCommandOpen(true)}
          />
          <DeskMenuSeparator />
          <DeskMenuItem
            label="Lock layout"
            shortcut="mod+shift+l"
            checked={props.store.locked()}
            onSelect={() => props.store.toggleLocked()}
          />
          <DeskMenuItem label="Reset layout" onSelect={props.onResetLayout} />
          <DeskMenuItem
            testID="menu-copy-diagnostics"
            label="Copy diagnostics JSON"
            shortcut="mod+shift+c"
            onSelect={props.onCopyDiagnostics}
          />
          <DeskMenuSeparator />
          <DeskMenuItem
            testID="menu-appearance-system"
            label="System appearance"
            radio={true}
            checked={props.store.appearance() === "system"}
            onSelect={() => props.store.setAppearance("system")}
          />
          <DeskMenuItem
            testID="menu-appearance-light"
            label="Light appearance"
            radio={true}
            checked={props.store.appearance() === "light"}
            onSelect={() => props.store.setAppearance("light")}
          />
          <DeskMenuItem
            testID="menu-appearance-dark"
            label="Dark appearance"
            radio={true}
            checked={props.store.appearance() === "dark"}
            onSelect={() => props.store.setAppearance("dark")}
          />
          <DeskMenuSeparator />
          <DeskMenuItem
            testID="menu-ui-kit"
            label="UI kit…"
            shortcut="mod+u"
            onSelect={() => props.store.setUiKitOpen(true)}
          />
        </DeskMenu>
      </DeskToolbar>
    </View>
  );
}
