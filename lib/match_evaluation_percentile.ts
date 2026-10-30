/** Nearest-rank percentile on a pre-sorted ascending sample. */
export function percentileSorted(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, p));
  const idx = Math.ceil((clamped / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, idx)]!;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return percentileSorted(sorted, p);
}
