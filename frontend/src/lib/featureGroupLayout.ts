import type { FeatureGroupFeature } from "./types";

export const PRIORITY_TIERS = ["P0", "P1", "P2", "P3"] as const;
export type PriorityTier = (typeof PRIORITY_TIERS)[number];

export type FeatureLayout = Record<PriorityTier, string[]>;

export function bucketId(tier: PriorityTier): string {
  return `bucket:${tier}`;
}

export function tierFromBucket(id: string): PriorityTier | null {
  if (!id.startsWith("bucket:")) return null;
  const tier = id.slice("bucket:".length);
  return PRIORITY_TIERS.includes(tier as PriorityTier) ? (tier as PriorityTier) : null;
}

export function partitionByTier(features: FeatureGroupFeature[]): FeatureLayout {
  const out: FeatureLayout = { P0: [], P1: [], P2: [], P3: [] };
  for (const tier of PRIORITY_TIERS) {
    out[tier] = features
      .filter((f) => f.priority_tier === tier)
      .sort((a, b) => a.position - b.position)
      .map((f) => f.id);
  }
  return out;
}

export function applyFeatureLayout(
  features: FeatureGroupFeature[],
  layout: FeatureLayout,
): FeatureGroupFeature[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const next = [...features];
  let rank = 0;

  for (const tier of PRIORITY_TIERS) {
    for (let i = 0; i < layout[tier].length; i++) {
      const id = layout[tier][i];
      if (!id) continue;
      const row = byId.get(id);
      if (!row) continue;
      const idx = next.findIndex((f) => f.id === id);
      if (idx >= 0) {
        next[idx] = { ...row, priority_tier: tier, position: i, rank };
      }
      rank += 1;
    }
  }
  return next;
}
