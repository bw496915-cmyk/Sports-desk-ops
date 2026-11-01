/**
 * Read the newest capture:discover scratch JSON for probe env (customer + ticket sample).
 */
import { Glob } from "bun";
import { join } from "node:path";

export interface DiscoverProbeContext {
  readonly discoverDir: string;
  readonly customerId: string;
  readonly ticketNumber: string;
  readonly wagerNumber: string;
  readonly flag?: string;
}

export async function loadLatestDiscoverContext(
  root: string,
): Promise<DiscoverProbeContext | null> {
  const glob = new Glob("scratch/f402-discover/*/getBetTicker.json");
  const paths: string[] = [];
  for await (const rel of glob.scan({ cwd: root, absolute: true })) {
    paths.push(rel);
  }
  paths.sort();
  const latest = paths.at(-1);
  if (latest === undefined) return null;

  const raw = (await Bun.file(latest).json()) as {
    customers?: Array<{ customerId?: string }>;
    sampleWagers?: Array<{
      customerId?: string;
      ticketNumber?: string;
      wagerNumber?: string;
    }>;
    ticketSample?: {
      customerId?: string;
      ticketNumber?: string;
      wagerNumber?: string;
      flag?: string;
    } | null;
    pendingDeleteHit?: {
      customerId?: string;
      ticketNumber?: string;
      wagerNumber?: string;
      flag?: string;
    } | null;
  };

  const ticketSample = raw.pendingDeleteHit ?? raw.ticketSample;
  const sample = raw.sampleWagers?.[0];
  const customerId =
    ticketSample?.customerId?.trim() ||
    sample?.customerId?.trim() ||
    raw.customers?.[0]?.customerId?.trim() ||
    "";
  if (customerId === "") return null;

  return {
    discoverDir: latest.replace(/\/getBetTicker\.json$/, ""),
    customerId,
    ticketNumber:
      ticketSample?.ticketNumber?.trim() ?? sample?.ticketNumber?.trim() ?? "",
    wagerNumber:
      ticketSample?.wagerNumber?.trim() ?? sample?.wagerNumber?.trim() ?? "",
    ...(ticketSample?.flag?.trim() ? { flag: ticketSample.flag.trim() } : {}),
  };
}

export async function discoverContextFromRoot(
  cwd = join(import.meta.dir, "../.."),
): Promise<DiscoverProbeContext | null> {
  return loadLatestDiscoverContext(cwd);
}
