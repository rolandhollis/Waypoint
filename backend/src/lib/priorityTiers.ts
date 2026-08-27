export const PRIORITY_TIERS = ["P0", "P1", "P2", "P3"] as const;
export type PriorityTier = (typeof PRIORITY_TIERS)[number];

export function normalizePriorityTier(raw: string): { tier: PriorityTier; coerced: boolean } {
  const t = raw.trim().toUpperCase();
  if (PRIORITY_TIERS.includes(t as PriorityTier)) {
    return { tier: t as PriorityTier, coerced: false };
  }
  return { tier: "P3", coerced: true };
}
