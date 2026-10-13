/**
 * Map Waypoint team names → SHOP Pod select options.
 * Keep in sync with frontend/src/lib/jpdCsvExport.ts (SHOP_POD_OPTIONS /
 * WAYPOINT_TEAM_TO_POD / resolveShopPods).
 */

export const SHOP_POD_OPTIONS = [
  "Agentic Search",
  "Core",
  "Data",
  "Extensions",
  "Loyalty",
  "MarTech",
  "Merchandising",
  "Mobile App",
  "Personalization",
  "Product Deals",
] as const;

const WAYPOINT_TEAM_TO_POD: Record<string, (typeof SHOP_POD_OPTIONS)[number]> = {
  martech: "MarTech",
  "data eng": "Data",
};

const SHOP_POD_BY_LOWER = new Map(
  SHOP_POD_OPTIONS.map((pod) => [pod.toLowerCase(), pod] as const),
);

function resolveOnePod(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const aliased = WAYPOINT_TEAM_TO_POD[key];
  if (aliased) return aliased;
  return SHOP_POD_BY_LOWER.get(key) ?? null;
}

/**
 * All Waypoint teams that map to existing SHOP Pod options (deduped,
 * order preserved). Unmatched teams are skipped.
 */
export function resolveShopPods(teamNames: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of teamNames) {
    const pod = resolveOnePod(name);
    if (!pod || seen.has(pod)) continue;
    seen.add(pod);
    out.push(pod);
  }
  return out;
}

/** @deprecated Prefer resolveShopPods — kept for single-value callers. */
export function resolveShopPod(teamNames: string[]): string | null {
  return resolveShopPods(teamNames)[0] ?? null;
}
