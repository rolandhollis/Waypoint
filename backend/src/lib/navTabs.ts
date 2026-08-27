/** Nav tab keys admins can rename via `groups.constants.tab_labels`. */
export const TAB_LABEL_KEYS = [
  "board",
  "prioritization",
  "roadmap",
  "status_report",
  "ezestimates",
  "kpis",
  "phases",
  "simple_features",
  "design",
  "feature_groups",
  "game",
  "admin",
] as const;

export type TabLabelKey = (typeof TAB_LABEL_KEYS)[number];

export type TabLabels = Partial<Record<TabLabelKey, string | null>>;

export function isTabLabelKey(k: string): k is TabLabelKey {
  return (TAB_LABEL_KEYS as readonly string[]).includes(k);
}
