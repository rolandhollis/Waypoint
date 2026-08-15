/**
 * Nav tab keys and built-in default labels. Admins can override per
 * workspace via `groups.constants.tab_labels`.
 */
export const TAB_LABEL_KEYS = [
  "home",
  "board",
  "prioritization",
  "roadmap",
  "status_report",
  "ezestimates",
  "kpis",
  "phases",
  "simple_features",
  "design",
  "game",
  "admin",
] as const;

export type TabLabelKey = (typeof TAB_LABEL_KEYS)[number];

export const DEFAULT_TAB_LABELS: Record<TabLabelKey, string> = {
  home: "Home",
  board: "Board",
  prioritization: "Prioritization",
  roadmap: "Roadmap",
  status_report: "Status Report",
  ezestimates: "EZEstimates",
  kpis: "KPIs",
  phases: "Phases",
  simple_features: "Simple Features",
  design: "Design",
  game: "Game",
  admin: "Admin",
};

/** Default page subtitle shown under the title in each view header. */
export const TAB_PAGE_DESCRIPTIONS: Partial<Record<TabLabelKey, string>> = {
  home: "Workspace snapshot and recent activity.",
  board: "Kanban view of work across swim lanes.",
  roadmap: "Timeline of scheduled initiatives and phase bars.",
  status_report: "Submit and review weekly status updates.",
  prioritization: "Drag to reorder. Changes cascade to Board swim-lane order and Roadmap Priority sort.",
  ezestimates: "Bulk-edit phase lengths with T-shirt size presets.",
  kpis: "Roadmap-visible projects grouped by KPI, sorted by upcoming end date.",
  phases: "What each board phase means — definitions for every swim lane.",
  simple_features:
    "Small initiatives under 16 hours of work that are not tracked on the roadmap.",
  design:
    "Design queue from this tab, roadmap design lanes, and Simple Features flagged needs design.",
  game: "Daily prediction — vote yes or no before 5pm Central. Expect mild irreverence.",
  admin: "Manage swim lanes, teams, users, and workspace settings.",
};

export type TabLabels = Partial<Record<TabLabelKey, string | null>>;

/** Route path for each nav tab (used by TopNav grouping). */
export const TAB_ROUTES: Record<TabLabelKey, string> = {
  home: "/",
  board: "/board",
  prioritization: "/prioritization",
  roadmap: "/roadmap",
  status_report: "/status-report",
  ezestimates: "/ezestimates",
  kpis: "/kpis",
  phases: "/phases",
  simple_features: "/simple-features",
  design: "/design",
  game: "/game",
  admin: "/admin",
};

/** Always-visible primary nav tabs. Home (`/`) is brand-icon only, not a tab. */
export const PRIMARY_NAV_KEYS: TabLabelKey[] = ["board", "roadmap", "status_report"];


export type NavDropdownSection = {
  keys: TabLabelKey[];
  /** Optional in-menu section label (e.g. "Reference"). */
  label?: string;
};

export type NavDropdownGroup = {
  id: string;
  menuLabel: string;
  sections: NavDropdownSection[];
};

/**
 * Themed nav dropdowns — each group is a coherent workflow, not a
 * grab-bag of leftover tabs.
 */
export const NAV_DROPDOWN_GROUPS: NavDropdownGroup[] = [
  {
    id: "plan",
    menuLabel: "Plan",
    sections: [{ keys: ["prioritization", "ezestimates"] }],
  },
  {
    id: "queues",
    menuLabel: "Queues",
    sections: [{ keys: ["simple_features", "design"] }],
  },
  {
    id: "reference",
    menuLabel: "Reference",
    sections: [{ keys: ["kpis", "phases"] }],
  },
];

export function parentNavDropdownForTab(tabKey: TabLabelKey): NavDropdownGroup | undefined {
  return NAV_DROPDOWN_GROUPS.find((group) => navDropdownGroupKeys(group).includes(tabKey));
}

export function resolveActiveTabKey(pathname: string): TabLabelKey | null {
  for (const key of TAB_LABEL_KEYS) {
    if (isNavPathActive(pathname, TAB_ROUTES[key])) return key;
  }
  return null;
}

export function navDropdownGroupKeys(group: NavDropdownGroup): TabLabelKey[] {
  return group.sections.flatMap((section) => section.keys);
}

export function isNavPathActive(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function isNavGroupActive(pathname: string, keys: TabLabelKey[]): boolean {
  return keys.some((key) => isNavPathActive(pathname, TAB_ROUTES[key]));
}

export function isNavDropdownGroupActive(pathname: string, group: NavDropdownGroup): boolean {
  return isNavGroupActive(pathname, navDropdownGroupKeys(group));
}

/** Effective labels for display — defaults merged with workspace overrides. */
export function resolveTabLabels(overrides?: TabLabels | null): Record<TabLabelKey, string> {
  const out = { ...DEFAULT_TAB_LABELS };
  if (!overrides) return out;
  for (const key of TAB_LABEL_KEYS) {
    const raw = overrides[key];
    if (raw === null || raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** Draft/persisted shape for the admin editor (override strings only). */
export function tabLabelOverridesToDraft(overrides?: TabLabels | null): Record<TabLabelKey, string> {
  const out = {} as Record<TabLabelKey, string>;
  for (const key of TAB_LABEL_KEYS) {
    const raw = overrides?.[key];
    out[key] = typeof raw === "string" ? raw : "";
  }
  return out;
}
