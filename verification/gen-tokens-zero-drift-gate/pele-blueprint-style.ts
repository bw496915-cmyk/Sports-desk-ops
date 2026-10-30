/** Blueprint theme for Pele SVG output (statechart hand-off). */
export const PELE_BLUEPRINT_STYLE = `<style>
.pele {
  --pele-bg: #e6f0fa;
  --pele-fg: #0c2d4d;
  --pele-muted: #3d5a73;
  --pele-line: #1e5a8a;
  --pele-surface: #f4f9fd;
  --pele-surface-alt: #d4e8f7;
  --pele-border: #2563a0;
}
.pele .blue rect { fill: #b8d4eb; stroke: #1e5a8a; stroke-width: 1.5px; }
.pele .orange rect { fill: #c9ddd4; stroke: #1e5a8a; stroke-width: 1.5px; }
.pele .purple rect { fill: #c4cce8; stroke: #1e5a8a; stroke-width: 1.5px; }
.pele .yellow rect { fill: #e8e4b8; stroke: #1e5a8a; stroke-width: 1.5px; }
.pele .teal rect { fill: #b8e0dc; stroke: #1e5a8a; stroke-width: 1.5px; }
.pele .tan rect { fill: #ddd4c4; stroke: #1e5a8a; stroke-width: 1.5px; }
.pele .pink rect { fill: #e8c4d8; stroke: #1e5a8a; stroke-width: 1.5px; }
.pele .breaks rect {
  fill: #ffecee !important;
  stroke: #c41e3a !important;
  stroke-width: 2.5px !important;
}
.pele .breaks text { fill: #8b0000 !important; }
.pele .mayBreak rect {
  fill: #fff8e6 !important;
  stroke: #c87800 !important;
  stroke-width: 2.5px !important;
}
.pele .mayBreak text { fill: #7a4a00 !important; }
.pele .bugPath rect {
  stroke: #0066cc !important;
  stroke-width: 2.5px !important;
}
.pele .repeats rect {
  stroke: #7a3db8 !important;
  stroke-width: 2.5px !important;
  stroke-dasharray: 6 3;
}
@media (prefers-color-scheme: dark) {
  .pele {
    --pele-bg: #0a1628;
    --pele-fg: #c8e0f4;
    --pele-muted: #8aa8c4;
    --pele-line: #4a9fd4;
    --pele-surface: #0f2038;
    --pele-surface-alt: #1a3050;
    --pele-border: #3a7ab8;
  }
  .pele .blue rect { fill: #1a3858; }
  .pele .yellow rect { fill: #484018; }
  .pele .teal rect { fill: #184840; }
}
</style>`;

export function injectBlueprintStyle(svg: string): string {
  const idx = svg.indexOf(">");
  if (idx === -1) return svg;
  return `${svg.slice(0, idx + 1)}\n${PELE_BLUEPRINT_STYLE}\n${svg.slice(idx + 1)}`;
}
