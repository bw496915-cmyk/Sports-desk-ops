import { colorScheme, signal, Text, View, type JSX } from "nsh";
import type { DeskAppearance } from "../desk_model";
import { DeskButton, DeskIconButton } from "./Button";
import { DeskDialog } from "./Dialog";
import { DeskIcon, type IconName } from "./Icon";
import { SegmentedTabs, type SegmentedTabItem } from "./SegmentedTabs";
import {
  Badge,
  SectionHeader,
  Separator,
  StateNotice,
  Surface,
} from "./Surface";
import { DeskSwitch } from "./Switch";

const APPEARANCE_ITEMS: readonly SegmentedTabItem<DeskAppearance>[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const DEMO_TABS: readonly SegmentedTabItem<"signals" | "kpis" | "sinks">[] = [
  { id: "signals", label: "Signals" },
  { id: "kpis", label: "KPIs" },
  { id: "sinks", label: "Sinks" },
];

const SHOWCASE_ICONS: readonly IconName[] = [
  "refresh",
  "search",
  "command",
  "check",
  "chevron-down",
  "copy",
  "lock",
  "close",
];

/**
 * Interactive showcase of every `packages/nsh-desk/ui/` control across its
 * variants, sizes, vector icons, tooltips, and states in both Light and Dark
 * appearances, per `nsh-design-guides` ("The app's `ui` layer" -> "Show it").
 */
export function UiKitGalleryDialog(props: {
  open: boolean;
  appearance: DeskAppearance;
  onAppearanceChange: (next: DeskAppearance) => void;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const sampleSwitch = signal(true);
  const sampleTab = signal<"signals" | "kpis" | "sinks">("signals");

  return (
    <DeskDialog
      testID="ui-kit-dialog"
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Sportsdesk UI kit"
      subtitle="Semantic tokens, vector icons, variants, sizes, and states across Light and Dark appearances."
    >
      <Surface variant="inset" class="gap-2">
        <SectionHeader
          title="Appearance preview"
          trailing={`active: ${colorScheme()}`}
        />
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <Text class="text-xs text-muted-foreground">
            Synced with workspace appearance preference in Storage.
          </Text>
          <SegmentedTabs
            accessibilityLabel="Theme appearance"
            items={APPEARANCE_ITEMS}
            value={props.appearance}
            onChange={props.onAppearanceChange}
          />
        </View>
      </Surface>

      <View class="gap-2">
        <SectionHeader title="Buttons — variants & states" />
        <View class="flex-row flex-wrap items-center gap-2">
          <DeskButton
            label="Primary"
            icon="command"
            variant="primary"
            tooltip="Themed Tooltip bubble with shortcut"
            shortcutHint="mod+k"
            onPress={() => {}}
          />
          <DeskButton
            label="Default"
            icon="refresh"
            variant="default"
            onPress={() => {}}
          />
          <DeskButton label="Outline" variant="outline" onPress={() => {}} />
          <DeskButton label="Ghost" variant="ghost" onPress={() => {}} />
          <DeskButton label="Danger" variant="danger" onPress={() => {}} />
          <DeskButton
            label="Selected"
            variant="outline"
            selected={true}
            onPress={() => {}}
          />
          <DeskButton
            label="Disabled"
            variant="outline"
            disabled={true}
            onPress={() => {}}
          />
          <DeskIconButton
            icon="refresh"
            accessibilityLabel="Sample refresh icon button"
            shortcutHint="mod+r"
            variant="outline"
            onPress={() => {}}
          />
        </View>
      </View>

      <View class="gap-2">
        <SectionHeader title="Buttons — size scale (xs / sm / md) & vector icons" />
        <View class="flex-row flex-wrap items-center justify-between gap-3">
          <View class="flex-row flex-wrap items-center gap-2">
            <DeskButton label="Size xs" size="xs" onPress={() => {}} />
            <DeskButton label="Size sm" size="sm" onPress={() => {}} />
            <DeskButton label="Size md" size="md" onPress={() => {}} />
          </View>
          <View class="flex-row flex-wrap items-center gap-2 rounded-(--radius) border border-border bg-card px-2.5 py-1.5">
            <Each of={SHOWCASE_ICONS} key={(name) => name}>
              {(name) => (
                <DeskIcon name={name()} size={14} tone="card-foreground" />
              )}
            </Each>
          </View>
        </View>
      </View>

      <Separator />

      <View class="gap-2">
        <SectionHeader title="Switch & sliding segmented tabs" />
        <View class="flex-row flex-wrap items-center justify-between gap-3">
          <DeskSwitch
            label={sampleSwitch() ? "Sample toggle: on" : "Sample toggle: off"}
            checked={sampleSwitch()}
            tooltip="Immediate setting switch"
            onChange={(next) => sampleSwitch.set(next)}
          />
          <SegmentedTabs
            accessibilityLabel="Sample segmented tabs"
            items={DEMO_TABS}
            value={sampleTab()}
            onChange={(next) => sampleTab.set(next)}
          />
        </View>
      </View>

      <Separator />

      <View class="gap-2">
        <SectionHeader title="Semantic status badges (text + token)" />
        <View class="flex-row flex-wrap items-center gap-2">
          <Badge label="NEUTRAL · FIXTURE" tone="neutral" />
          <Badge label="LIVE · 12s" tone="positive" />
          <Badge label="DATA-STALE · #78" tone="warning" />
          <Badge label="HTTP 503 · UNAUTHORIZED" tone="danger" />
        </View>
      </View>

      <Separator />

      <View class="gap-2">
        <SectionHeader title="Surfaces & state notices" />
        <Surface variant="card" class="gap-2">
          <Text class="text-xs font-medium text-card-foreground">
            Card surface — concentric outer (8pt) and inner (6pt) radii
          </Text>
          <Surface variant="inset">
            <StateNotice
              kind="unavailable"
              title="Sample unavailable endpoint"
              detail="/api/live-bets/summary HTTP 503 [unauthorized]: missing F402 bearer"
            />
          </Surface>
        </Surface>
      </View>
    </DeskDialog>
  );
}
