import { createMotion, LayoutAnimation, reduceMotion } from "nsh";
import type { ScrollbarTheme } from "nsh/base";

export type ControlSize = "xs" | "sm" | "md";

export const MOTION = {
  instant: 100,
  fast: 150,
  base: 200,
  slow: 300,
  buttonTransitionClass:
    "transition duration-100 ease-out active:duration-150 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
  iconButtonTransitionClass:
    "transition duration-100 ease-out active:duration-150 active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100",
  popupTransitionClass:
    "transition duration-150 ease-out motion-reduce:transition-none",
} as const;

export const FOCUS_RING_CLASS =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export const POPUP_SURFACE_CLASS =
  "min-w-52 rounded-(--radius) border border-border bg-popover p-1 shadow-lg";

export const TOOLTIP_SURFACE_CLASS =
  "max-w-64 rounded-(--radius-sm) border border-border bg-popover px-2 py-1 shadow-md";

export const POPUP_STARTING_CLASS =
  "opacity-0 scale-95 -translate-y-1 motion-reduce:opacity-100 motion-reduce:scale-100 motion-reduce:translate-y-0";

export const POPUP_ENDING_CLASS =
  "opacity-0 scale-95 -translate-y-1 motion-reduce:opacity-100 motion-reduce:scale-100 motion-reduce:translate-y-0";

export const SCRIM_BACKDROP_CLASS = "bg-foreground/30 dark:bg-background/70";

/**
 * Shared NSH v0.4.0 `ScrollbarTheme` placed on outer `<Scroll>` viewports so
 * inner `p-3` / `p-4` content spines stay aligned and scrollbars never overlap text.
 */
export const DESK_SCROLLBAR_THEME: ScrollbarTheme = {
  mode: "scrolling",
  minThumbLength: 36,
  motion: {
    idle: 1400,
    enter: 100,
    exit: 180,
    entrance: "fade",
  },
  vertical: {
    class: "w-2.5 p-0.5",
    thumbClass:
      "rounded-full bg-muted-foreground/35 transition-colors duration-100 hover:bg-muted-foreground/55 motion-reduce:transition-none",
    accessibilityLabel: "Vertical scroll position",
  },
  horizontal: {
    class: "h-2.5 p-0.5",
    thumbClass:
      "rounded-full bg-muted-foreground/35 transition-colors duration-100 hover:bg-muted-foreground/55 motion-reduce:transition-none",
    accessibilityLabel: "Horizontal scroll position",
  },
};

/**
 * Animates layout changes initiated directly by a user command (dock toggle,
 * layout reset). Never call on window resize or background data ticks.
 */
export function animateUserLayoutChange(): void {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext(
    LayoutAnimation.create(MOTION.base, "easeInEaseOut", "opacity"),
  );
}

/**
 * Component-owned entrance fade for panel content transitioning from initial
 * loading into ready state. Honors reduceMotion natively.
 */
export function createPanelReadyMotion() {
  return createMotion({ enter: "fadeIn", duration: MOTION.fast });
}
