import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownAZ, GripVertical, Mail, Send, Sparkles, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import {
  useAiEstimatorHealth,
  useGroupMembers,
  useGroups,
  useHealth,
  useIsAdmin,
  useIsSuperUser,
  useKpis,
  useMe,
  useProjects,
  useSwimLanes,
  useTeams,
  useTshirtSizes,
  useUnassignedUsers,
  useUserGroups,
  useUsers,
} from "../lib/queries";
import type { Group, Kpi, PhaseDateKey, Project, Role, SwimLane, Team, TshirtSize, User } from "../lib/types";
import { AdminConstants } from "../components/AdminConstants";
import { AiReferenceEstimatesAdmin } from "../components/AiReferenceEstimatesAdmin";
import { CsvExportAdmin } from "../components/CsvExportAdmin";
import { CsvImportAdmin } from "../components/CsvImportAdmin";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { PasswordField } from "../components/PasswordField";
import { passwordIsValid } from "../lib/password";
import { GROUP_PALETTE, KPI_PALETTE, SWIM_LANE_PALETTE, TEAM_PALETTE, USER_PALETTE } from "../lib/colors";
import { useAutoColor } from "../lib/useAutoColor";
import { RevealPasswordCard } from "../components/RevealPasswordCard";
import { useViewStore, type AdminSubTabState, type AdminTopTabKey } from "../lib/viewState";
import { X } from "lucide-react";

type TopTabDef = {
  key: AdminTopTabKey;
  label: string;
  /** Render function for tabs with no sub-tabs. `subTabs` overrides this. */
  render?: () => JSX.Element;
  /** SuperUser-only tabs are filtered out of the tablist for
   *  everyone else (i.e. hidden, not just disabled). Set on the sub-
   *  tab where the gating is granular. */
  superUserOnly?: boolean;
  /** Two-level tabs. When present, the panel renders a sub-tab
   *  nav strip whose items follow the same shape. */
  subTabs?: SubTabDef[];
};

type SubTabDef = {
  key: string;
  label: string;
  render: () => JSX.Element;
  superUserOnly?: boolean;
};

// The Groups admin (previously a top-level tab) now lives as a
// sub-tab under "Workspace" alongside the other tenant-catalog
// screens. Keeping the CSV Import/Export together too — they share
// the same file/data-plumbing story so they cluster naturally.
const TOP_TABS: TopTabDef[] = [
  {
    key: "workspace",
    label: "Workspace",
    subTabs: [
      { key: "groups", label: "Groups",     render: () => <GroupsAdmin />, superUserOnly: true },
      { key: "lanes",  label: "Swim lanes", render: () => <SwimLanesAdmin /> },
      { key: "teams",  label: "Teams",      render: () => <TeamsAdmin /> },
      { key: "kpis",   label: "KPIs",       render: () => <KpisAdmin /> },
    ],
  },
  { key: "users",                  label: "Users",                 render: () => <UsersAdmin /> },
  // Note: the underlying tab key stays "archived" so old
  // `?tab=archived` bookmarks continue to resolve, but the label
  // reads "Deleted cards" now that we have a distinct Archive
  // swim-lane concept — this tab is only about the hard-delete
  // (soft-delete via deleted_at) flow.
  { key: "archived",               label: "Deleted cards",         render: () => <ArchivedProjectsAdmin /> },
  { key: "notifications",          label: "Notifications",         render: () => <NotificationsAdmin /> },
  { key: "tshirt-sizes",           label: "T-Shirt Sizes",         render: () => <TshirtSizesAdmin /> },
  { key: "ai-reference-estimates", label: "AI reference estimates", render: () => <AiReferenceEstimatesAdmin /> },
  {
    key: "csv",
    label: "CSV",
    subTabs: [
      { key: "import", label: "Import", render: () => <CsvImportAdmin /> },
      { key: "export", label: "Export", render: () => <CsvExportAdmin /> },
    ],
  },
  // Constants slots in at the end because it's the most niche of the
  // set — new admins meet it after every other more-frequently-used
  // panel. Left-of-CSV would have separated it from the "adjust
  // knobs" cluster (Notifications / Sizes / Estimates) it's most
  // conceptually adjacent to, so it lands right of them but past
  // CSV, which is a distinct "data plumbing" concern.
  { key: "constants", label: "Constants", render: () => <AdminConstants /> },
];

/**
 * Map from a legacy flat-tab URL key (`?tab=lanes`) to the new
 * parent tab so old bookmarks / Slack links deep-link into the
 * correct nested panel without silently landing on the default.
 * The pair `{ parent, sub }` is applied by the resolver below.
 */
const LEGACY_TAB_TO_PARENT: Record<string, { parent: AdminTopTabKey; sub: string }> = {
  lanes:  { parent: "workspace", sub: "lanes" },
  teams:  { parent: "workspace", sub: "teams" },
  kpis:   { parent: "workspace", sub: "kpis" },
  groups: { parent: "workspace", sub: "groups" },
  import: { parent: "csv",       sub: "import" },
  export: { parent: "csv",       sub: "export" },
};

// -----------------------------------------------------------------
// Alphabetize an id-list by display name using locale-aware,
// case-insensitive compare with numeric awareness (so "Team 10"
// sorts after "Team 2"). Shared by the per-list "Sort A→Z" buttons
// on the Swim Lanes / Teams / KPIs admin tabs — one click sorts
// the catalog and immediately persists the new order via each
// list's existing `/reorder` endpoint.
function alphaSortIdsByName<T extends { id: string; name: string }>(items: T[]): string[] {
  return items
    .slice()
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    )
    .map((x) => x.id);
}

/** True when `items` is already ordered A→Z under the same
 *  comparator alphaSortIdsByName uses. Lets the Sort button
 *  render disabled once the list is a no-op away from sorted. */
function isAlphabetical<T extends { id: string; name: string }>(items: T[]): boolean {
  const sorted = alphaSortIdsByName(items);
  return items.every((it, i) => it.id === sorted[i]);
}

export function AdminSettingsView() {
  const isAdmin = useIsAdmin();
  const isSuperUser = useIsSuperUser();
  const [params, setParams] = useSearchParams();

  // Filter out super-user-only tabs (nothing at the top level today,
  // but the shape leaves room) and drop any super-user-only sub-tab
  // from every parent's sub-tab list for regular admins.
  const tabs = useMemo(() => {
    return TOP_TABS
      .filter((t) => !t.superUserOnly || isSuperUser)
      .map((t) => t.subTabs
        ? { ...t, subTabs: t.subTabs.filter((s) => !s.superUserOnly || isSuperUser) }
        : t);
  }, [isSuperUser]);

  const storedTop = useViewStore((s) => s.adminActiveTab);
  const storedSubs = useViewStore((s) => s.adminSubTabs);
  const setStoredTop = useViewStore((s) => s.setAdminActiveTab);
  const setStoredSub = useViewStore((s) => s.setAdminSubTab);

  // ?tab= (and ?subtab=) persist the active section across reloads and
  // are deep-linkable (e.g. Slack messages like
  // "check /admin?tab=workspace&subtab=teams"). The URL wins over the
  // persisted store when it carries a valid pick; falling back to the
  // stored pick, then to the first visible tab. Old flat-tab URLs
  // (?tab=lanes) get transparently upgraded to their parent+sub pair.
  const rawTab = params.get("tab") ?? "";
  const rawSub = params.get("subtab") ?? "";

  let activeTop: AdminTopTabKey;
  let urlSub: string | null = rawSub || null;
  const legacy = LEGACY_TAB_TO_PARENT[rawTab];
  if (legacy && tabs.find((t) => t.key === legacy.parent)) {
    activeTop = legacy.parent;
    urlSub = urlSub ?? legacy.sub;
  } else if (tabs.find((t) => t.key === (rawTab as AdminTopTabKey))) {
    activeTop = rawTab as AdminTopTabKey;
  } else if (storedTop && tabs.find((t) => t.key === storedTop)) {
    activeTop = storedTop;
  } else {
    activeTop = tabs[0]!.key;
  }

  const activeTopDef = tabs.find((t) => t.key === activeTop)!;
  const subTabs = activeTopDef.subTabs ?? [];

  // Sub-tab resolution mirrors the parent: URL first, then store,
  // then the first visible sub-tab. Only meaningful when the parent
  // actually has sub-tabs; single-panel parents just ignore this.
  let activeSub: string | null = null;
  if (subTabs.length > 0) {
    const parentKey = activeTop as keyof AdminSubTabState;
    const stored = storedSubs[parentKey];
    if (urlSub && subTabs.find((s) => s.key === urlSub)) {
      activeSub = urlSub;
    } else if (stored && subTabs.find((s) => s.key === stored)) {
      activeSub = stored;
    } else {
      activeSub = subTabs[0]!.key;
    }
  }

  // Admin access is per-group; a user who's viewer in the current
  // group but admin in another tenant sees "Admin access required"
  // here until they switch groups via the navbar dropdown.
  if (!isAdmin && !isSuperUser) {
    return <div className="p-6 text-sm text-wp-slate">Admin access required.</div>;
  }

  function setActive(key: AdminTopTabKey) {
    const next = new URLSearchParams(params);
    next.set("tab", key);
    // Reset ?subtab when switching parents so we don't carry a stale
    // sub id from the previous parent into a resolver that doesn't
    // recognize it (and would otherwise fall back to the default
    // silently).
    next.delete("subtab");
    setParams(next, { replace: true });
    setStoredTop(key);
  }

  function setSub(parentKey: AdminTopTabKey, subKey: string) {
    const next = new URLSearchParams(params);
    next.set("tab", parentKey);
    next.set("subtab", subKey);
    setParams(next, { replace: true });
    // Only parents with sub-tabs are recorded; the type guard on the
    // store's setter enforces that at the type level too.
    if (parentKey === "workspace" || parentKey === "csv") {
      setStoredSub(parentKey, subKey);
    }
  }

  const activeSubDef = activeSub ? subTabs.find((s) => s.key === activeSub) : null;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-xl font-semibold text-wp-ink">Admin Settings</h1>

      <TabNav
        ariaLabel="Admin sections"
        tabs={tabs.map((t) => ({ key: t.key, label: t.label }))}
        activeKey={activeTop}
        onSelect={(k) => setActive(k as AdminTopTabKey)}
        tabIdPrefix="admin-tab"
        panelIdPrefix="admin-panel"
      />

      <div
        role="tabpanel"
        id={`admin-panel-${activeTop}`}
        aria-labelledby={`admin-tab-${activeTop}`}
        className="mt-6"
      >
        {subTabs.length > 0 ? (
          <>
            <TabNav
              ariaLabel={`${activeTopDef.label} sub-sections`}
              tabs={subTabs.map((s) => ({ key: s.key, label: s.label }))}
              activeKey={activeSub!}
              onSelect={(k) => setSub(activeTop, k)}
              tabIdPrefix={`admin-subtab-${activeTop}`}
              panelIdPrefix={`admin-subpanel-${activeTop}`}
              variant="sub"
            />
            <div
              role="tabpanel"
              id={`admin-subpanel-${activeTop}-${activeSub}`}
              aria-labelledby={`admin-subtab-${activeTop}-${activeSub}`}
              className="mt-6"
            >
              {activeSubDef ? activeSubDef.render() : null}
            </div>
          </>
        ) : activeTopDef.render ? (
          activeTopDef.render()
        ) : null}
      </div>
    </div>
  );
}

/**
 * Shared tab-nav strip used at both the top-level and sub-tab
 * levels of the Admin view. Keeping this local to the file (rather
 * than in `frontend/src/components/`) because it is *only* used
 * here — every other view in the app either uses no tabs or has
 * bespoke navigation. If a second call site appears, promote this
 * to a shared component.
 *
 * `variant`:
 *   * `"top"` (default) — the underline-bar strip that sits under
 *     the page title. Matches the pre-nesting Admin tab styling
 *     exactly so the shell doesn't look different post-refactor.
 *   * `"sub"` — the nested strip inside a parent panel. Same
 *     underline idiom (for visual consistency with the top level)
 *     but rendered a step smaller and against a lighter divider so
 *     the two levels are still visually distinguishable.
 */
function TabNav({
  ariaLabel,
  tabs,
  activeKey,
  onSelect,
  tabIdPrefix,
  panelIdPrefix,
  variant = "top",
}: {
  ariaLabel: string;
  tabs: Array<{ key: string; label: string }>;
  activeKey: string;
  onSelect: (key: string) => void;
  /** Prefix used to build each tab button's DOM id (`{prefix}-{key}`).
   *  Matches the id caller uses for the tab's `aria-labelledby` on the
   *  panel — kept separate from `panelIdPrefix` because the tab and
   *  panel ids can't collide. */
  tabIdPrefix: string;
  /** Prefix used to build each tab's `aria-controls` (`{prefix}-{key}`).
   *  Must match the DOM id the caller renders on the corresponding
   *  `role="tabpanel"` element. */
  panelIdPrefix: string;
  variant?: "top" | "sub";
}) {
  const isTop = variant === "top";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={
        isTop
          ? "mt-4 flex gap-1 border-b border-wp-stone"
          : "flex gap-1 border-b border-wp-stone/60"
      }
    >
      {tabs.map((t) => {
        const isActive = t.key === activeKey;
        return (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-controls={`${panelIdPrefix}-${t.key}`}
            id={`${tabIdPrefix}-${t.key}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(t.key)}
            className={
              "-mb-px cursor-pointer border-b-2 transition " +
              (isTop
                ? "px-3 py-2 text-sm font-medium "
                : "px-2.5 py-1.5 text-xs font-medium ") +
              (isActive
                ? "border-wp-red text-wp-ink"
                : "border-transparent text-wp-slate hover:text-wp-ink")
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}


// -----------------------------------------------------------------
// Notifications admin — ad-hoc trigger for the weekly status
// reminder job. Two buttons:
//
//   Preview (dry run) — asks the server "who would you email?"
//     without sending or writing to notification_log. Safe to
//     click any number of times; useful for confirming the
//     roster before pulling the trigger.
//
//   Send now — actually sends. Uses the same notification_log
//     idempotency guard as the Thursday cron, so clicking it after
//     the cron has already fired (or clicking it twice in quick
//     succession) is a no-op for anyone who already got their
//     email this week. Recipients are scoped to the caller's
//     currently-selected group so a super-admin doesn't spam
//     other tenants by accident.
//
// Result panel keeps the last run visible so an admin can see
// what happened without hunting through logs.
// -----------------------------------------------------------------

type ReminderRunResult = {
  candidates: number;
  pendingOwners: number;
  sent: number;
  skippedAlreadySent: number;
  errors: number;
  weekOf: string;
  dryRun: boolean;
};

function NotificationsAdmin() {
  return (
    <div className="flex flex-col gap-4">
      <ReminderAdmin />
      <DigestAdmin />
      <AiEstimatorStatusRow />
    </div>
  );
}

/**
 * One-line read-only status row for the Claude-powered EZEstimates
 * suggester. Reads GET /projects/ai-estimator/health so it can tell
 * the admin whether ANTHROPIC_API_KEY is set on the current deploy.
 *
 * Deliberately read-only: the API key is a Fly secret, never a
 * value we surface through the UI (that would be a big security
 * regression). The remediation copy points the admin at the
 * `fly secrets set` command instead of implying they can flip it
 * here.
 */
function AiEstimatorStatusRow() {
  const health = useAiEstimatorHealth();
  const configured = health.data?.configured === true;
  const model = health.data?.model ?? null;
  return (
    <section className="card-surface p-4">
      <div className="flex items-start gap-3">
        <span
          className={
            "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full " +
            (configured
              ? "bg-emerald-100 text-emerald-700"
              : "bg-wp-stone/40 text-wp-slate")
          }
        >
          <Sparkles size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-wp-ink">
            AI phase-size estimator
          </h2>
          <p className="mt-1 text-xs text-wp-slate">
            Powers the [✨ Suggest] button on the EZEstimates view. Uses
            Anthropic Claude to size Discovery / Development / Post-Dev
            based on the T-shirt catalog and this workspace's recently
            completed projects.
          </p>
          {health.isLoading ? (
            <p className="mt-2 text-xs text-wp-slate">Checking status…</p>
          ) : health.isError ? (
            <p className="mt-2 text-xs text-red-700">
              Could not reach the health endpoint.
            </p>
          ) : configured ? (
            <p className="mt-2 text-xs text-emerald-800">
              <span className="font-semibold">Configured.</span> Using model{" "}
              <code className="rounded bg-wp-stone/40 px-1 py-0.5 text-[11px] text-wp-ink">
                {model}
              </code>
              . Rotate by setting <code>ANTHROPIC_MODEL</code> in Fly secrets.
            </p>
          ) : (
            <p className="mt-2 text-xs text-amber-800">
              <span className="font-semibold">Not configured.</span> The
              feature is dormant until an operator sets{" "}
              <code className="rounded bg-wp-stone/40 px-1 py-0.5 text-[11px] text-wp-ink">
                ANTHROPIC_API_KEY
              </code>{" "}
              in Fly secrets (
              <code className="rounded bg-wp-stone/40 px-1 py-0.5 text-[11px] text-wp-ink">
                fly secrets set ANTHROPIC_API_KEY=…
              </code>
              ). Until then the Suggest button returns a 503 with the same
              remediation copy.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ReminderAdmin() {
  const runReminders = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<ReminderRunResult>("/notifications/status-reminders/run", {
        method: "POST",
        body: JSON.stringify({ dry_run: dryRun }),
      }),
  });

  const busy = runReminders.isPending;
  const last = runReminders.data;

  return (
    <section className="card-surface p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-wp-red/10 text-wp-red">
          <Mail size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-wp-ink">
            Weekly status-report reminder
          </h2>
          <p className="mt-1 text-xs text-wp-slate">
            Sends one email per owner listing the status updates they owe this week.
            Runs automatically every Thursday morning; use these buttons to preview or
            fire it on demand. Scoped to the group you're currently viewing.
          </p>
        </div>
      </div>

      <MutationErrorBanner mutation={runReminders} className="mt-4" />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={busy}
          onClick={() => runReminders.mutate(true)}
        >
          <Mail size={13} />
          {busy && runReminders.variables === true ? "Previewing…" : "Preview (dry run)"}
        </button>
        <button
          type="button"
          className="btn-primary inline-flex items-center gap-1.5"
          disabled={busy}
          onClick={() => {
            if (
              !confirm(
                "Send reminder emails now to every owner in this group who owes a status update this week?\n\nOwners who already got one this week are automatically skipped.",
              )
            ) return;
            runReminders.mutate(false);
          }}
        >
          <Send size={13} />
          {busy && runReminders.variables === false ? "Sending…" : "Send now"}
        </button>
      </div>

      {last ? (
        <div
          className={
            "mt-4 rounded-md border px-3 py-2 text-xs " +
            (last.dryRun
              ? "border-wp-stone bg-wp-stone/20 text-wp-ink"
              : "border-emerald-200 bg-emerald-50 text-emerald-900")
          }
          role="status"
          aria-live="polite"
        >
          <div className="font-semibold">
            {last.dryRun
              ? "Preview complete — no emails sent, no log rows written."
              : "Reminders sent."}
          </div>
          <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
            <li>
              <span className="text-wp-slate">Week of</span>
              <span className="ml-1 font-mono">{last.weekOf}</span>
            </li>
            <li>
              <span className="text-wp-slate">Owners with pending</span>
              <span className="ml-1 font-mono">{last.pendingOwners}</span>
            </li>
            <li>
              <span className="text-wp-slate">Opted-in candidates</span>
              <span className="ml-1 font-mono">{last.candidates}</span>
            </li>
            <li>
              <span className="text-wp-slate">
                {last.dryRun ? "Would send" : "Sent"}
              </span>
              <span className="ml-1 font-mono">{last.sent}</span>
            </li>
            {last.skippedAlreadySent > 0 ? (
              <li className="col-span-2">
                <span className="text-wp-slate">Skipped (already sent this week)</span>
                <span className="ml-1 font-mono">{last.skippedAlreadySent}</span>
              </li>
            ) : null}
            {last.errors > 0 ? (
              <li className="col-span-2 text-red-700">
                <span>Errors</span>
                <span className="ml-1 font-mono">{last.errors}</span>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <p className="mt-4 text-[11px] text-wp-slate/80">
        Users opt out from their profile dialog (top-right nav) or by clicking the
        unsubscribe link in any reminder email. Opt-outs stick — an admin re-triggering
        the job never overrides an individual choice.
      </p>
    </section>
  );
}

// -----------------------------------------------------------------
// Digest admin — Friday-afternoon rollup of the week's completed
// status updates. Two concerns:
//
//   1. Recipient roster (add/remove). Admins pick from registered
//      users in this group OR type an ad-hoc email address (execs,
//      contractors, PMs who don't need a Waypoint login).
//   2. On-demand send (dry-run + real) that mirrors the reminder
//      trigger's contract. Uses notification_log for idempotency so
//      the same (group, email, week) can never double-send.
// -----------------------------------------------------------------

type DigestRecipient = {
  id: string;
  email: string;
  user: { id: string; name: string; email: string } | null;
  created_at: string;
};

type DigestRunResult = {
  weekOf: string;
  dryRun: boolean;
  groups: number;
  recipients: number;
  updatesIncluded: number;
  sent: number;
  skippedAlreadySent: number;
  skippedEmptyGroups: number;
  errors: number;
};

function DigestAdmin() {
  const qc = useQueryClient();
  const recipients = useQuery({
    queryKey: ["digestRecipients"],
    queryFn: () => api<DigestRecipient[]>("/notifications/digest-recipients"),
  });
  const users = useUsers();

  const addUser = useMutation({
    mutationFn: (user_id: string) =>
      api<{ id: string }>("/notifications/digest-recipients/user", {
        method: "POST",
        body: JSON.stringify({ user_id }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["digestRecipients"] }),
  });
  const addEmail = useMutation({
    mutationFn: (email: string) =>
      api<{ id: string }>("/notifications/digest-recipients/email", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["digestRecipients"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/notifications/digest-recipients/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["digestRecipients"] }),
  });
  const runDigest = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<DigestRunResult>("/notifications/status-digest/run", {
        method: "POST",
        body: JSON.stringify({ dry_run: dryRun }),
      }),
  });

  const [mode, setMode] = useState<"user" | "email">("user");
  const [pickUserId, setPickUserId] = useState<string>("");
  const [emailInput, setEmailInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  const recipientEmails = useMemo(
    () => new Set((recipients.data ?? []).map((r) => r.email.toLowerCase())),
    [recipients.data],
  );

  // Users the admin can pick from — members of this group whose
  // email isn't already on the list. Alphabetized by name so the
  // dropdown is stable across reloads.
  const pickableUsers = useMemo(() => {
    const list = users.data ?? [];
    return list
      .filter((u) => u.email && !recipientEmails.has(u.email.toLowerCase()))
      .slice()
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }, [users.data, recipientEmails]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput.trim());

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setEmailError(null);
    if (mode === "user") {
      if (!pickUserId) return;
      addUser.mutate(pickUserId, {
        onSuccess: () => setPickUserId(""),
        onError: (err) => setEmailError(err instanceof Error ? err.message : "failed to add"),
      });
    } else {
      const email = emailInput.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setEmailError("Enter a valid email address.");
        return;
      }
      if (recipientEmails.has(email.toLowerCase())) {
        setEmailError("That email is already on the list.");
        return;
      }
      addEmail.mutate(email, {
        onSuccess: () => setEmailInput(""),
        onError: (err) => setEmailError(err instanceof Error ? err.message : "failed to add"),
      });
    }
  }

  const busySend = runDigest.isPending;
  const lastRun = runDigest.data;

  return (
    <section className="card-surface p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-wp-red/10 text-wp-red">
          <Mail size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-wp-ink">
            Weekly status-report digest
          </h2>
          <p className="mt-1 text-xs text-wp-slate">
            Rolls up this week's completed status updates and emails the roster below.
            Runs automatically every Friday at 5:00 PM Central. Skips silently when
            the group has zero completed updates or zero recipients. Scoped to the
            group you're currently viewing.
          </p>
        </div>
      </div>

      <MutationErrorBanner mutation={runDigest} className="mt-4" />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={busySend}
          onClick={() => runDigest.mutate(true)}
        >
          <Mail size={13} />
          {busySend && runDigest.variables === true ? "Previewing…" : "Preview (dry run)"}
        </button>
        <button
          type="button"
          className="btn-primary inline-flex items-center gap-1.5"
          disabled={busySend}
          onClick={() => {
            if (
              !confirm(
                "Send the weekly digest email now to every recipient in this group's list?\n\nRecipients who already got one this week are automatically skipped.",
              )
            ) return;
            runDigest.mutate(false);
          }}
        >
          <Send size={13} />
          {busySend && runDigest.variables === false ? "Sending…" : "Send now"}
        </button>
      </div>

      {lastRun ? (
        <div
          className={
            "mt-4 rounded-md border px-3 py-2 text-xs " +
            (lastRun.dryRun
              ? "border-wp-stone bg-wp-stone/20 text-wp-ink"
              : "border-emerald-200 bg-emerald-50 text-emerald-900")
          }
          role="status"
          aria-live="polite"
        >
          <div className="font-semibold">
            {lastRun.dryRun
              ? "Preview complete — no emails sent, no log rows written."
              : "Digests sent."}
          </div>
          <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
            <li>
              <span className="text-wp-slate">Week of</span>
              <span className="ml-1 font-mono">{lastRun.weekOf}</span>
            </li>
            <li>
              <span className="text-wp-slate">Recipients</span>
              <span className="ml-1 font-mono">{lastRun.recipients}</span>
            </li>
            <li>
              <span className="text-wp-slate">Updates included</span>
              <span className="ml-1 font-mono">{lastRun.updatesIncluded}</span>
            </li>
            <li>
              <span className="text-wp-slate">
                {lastRun.dryRun ? "Would send" : "Sent"}
              </span>
              <span className="ml-1 font-mono">{lastRun.sent}</span>
            </li>
            {lastRun.skippedAlreadySent > 0 ? (
              <li className="col-span-2">
                <span className="text-wp-slate">Skipped (already sent this week)</span>
                <span className="ml-1 font-mono">{lastRun.skippedAlreadySent}</span>
              </li>
            ) : null}
            {lastRun.errors > 0 ? (
              <li className="col-span-2 text-red-700">
                <span>Errors</span>
                <span className="ml-1 font-mono">{lastRun.errors}</span>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 border-t border-wp-stone/60 pt-4">
        <h3 className="text-sm font-semibold text-wp-ink">Digest recipients</h3>
        <p className="mt-0.5 text-xs text-wp-slate">
          Add anyone who should receive the Friday email — pick a group member from
          the dropdown or type an ad-hoc email for someone without a Waypoint account.
        </p>

        <form onSubmit={handleAdd} className="mt-3 flex flex-wrap items-start gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-wp-stone">
            <button
              type="button"
              className={
                "px-2.5 py-1.5 text-xs " +
                (mode === "user" ? "bg-wp-red text-white" : "bg-white text-wp-ink hover:bg-wp-stone/30")
              }
              onClick={() => { setMode("user"); setEmailError(null); }}
            >
              Add user
            </button>
            <button
              type="button"
              className={
                "px-2.5 py-1.5 text-xs " +
                (mode === "email" ? "bg-wp-red text-white" : "bg-white text-wp-ink hover:bg-wp-stone/30")
              }
              onClick={() => { setMode("email"); setEmailError(null); }}
            >
              Ad-hoc email
            </button>
          </div>

          {mode === "user" ? (
            <select
              className="input h-9 min-w-[240px]"
              value={pickUserId}
              onChange={(e) => setPickUserId(e.target.value)}
            >
              <option value="">— pick a user —</option>
              {pickableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input h-9 min-w-[240px]"
              type="email"
              placeholder="alice@example.com"
              value={emailInput}
              onChange={(e) => { setEmailInput(e.target.value); setEmailError(null); }}
              autoComplete="off"
            />
          )}

          <button
            type="submit"
            className="btn-primary h-9"
            disabled={
              addUser.isPending ||
              addEmail.isPending ||
              (mode === "user" ? !pickUserId : !emailValid)
            }
          >
            {addUser.isPending || addEmail.isPending ? "Adding…" : "Add"}
          </button>
        </form>
        {emailError ? (
          <p className="mt-2 text-xs text-red-700">{emailError}</p>
        ) : null}

        <MutationErrorBanner mutation={remove} className="mt-3" />

        <div className="mt-3">
          {recipients.isLoading ? (
            <p className="text-xs text-wp-slate">Loading recipients…</p>
          ) : (recipients.data ?? []).length === 0 ? (
            <p className="rounded-md border border-dashed border-wp-stone px-3 py-2 text-xs text-wp-slate">
              No recipients yet. The Friday digest won't send until at least one is added.
            </p>
          ) : (
            <ul className="divide-y divide-wp-stone rounded-md border border-wp-stone">
              {(recipients.data ?? []).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-wp-ink">
                      {r.user ? r.user.name : r.email}
                    </div>
                    <div className="truncate text-xs text-wp-slate">
                      {r.user ? r.user.email : "Ad-hoc address (no linked user)"}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-wp-slate hover:bg-red-50 hover:text-red-700"
                    aria-label={`Remove ${r.email}`}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (confirm(`Remove ${r.email} from the digest list?`)) {
                        remove.mutate(r.id);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function ArchivedProjectsAdmin() {
  const qc = useQueryClient();
  const all = useQuery({
    queryKey: ["projectsIncludingDeleted"],
    queryFn: () => api<Project[]>("/projects?include_deleted=true"),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api(`/projects/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["projectsIncludingDeleted"] });
    },
  });
  const archived = (all.data ?? []).filter((p) => p.deleted_at);
  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Deleted cards</h2>
      <p className="mt-1 text-xs text-wp-slate">
        Cards deleted via the board's Delete action land here. Restoring puts them back in their
        original lane. For a soft-hide that keeps cards addressable by lane, use the Archive swim
        lane instead (Admin → Swim lanes → mark a lane as <em>archive target</em>).
      </p>
      <MutationErrorBanner mutation={restore} className="mt-3" />
      {archived.length === 0 ? (
        <p className="mt-2 text-xs text-wp-slate">No deleted cards.</p>
      ) : (
        <ul className="mt-3 divide-y divide-wp-stone">
          {archived.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-wp-ink">{p.title}</div>
                <div className="text-xs text-wp-slate">deleted {p.deleted_at?.slice(0, 10)}</div>
              </div>
              <button className="btn-secondary text-xs" onClick={() => restore.mutate(p.id)}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SwimLanesAdmin() {
  const lanes = useSwimLanes();
  const projects = useProjects();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor, resetColor] = useAutoColor(
    SWIM_LANE_PALETTE,
    (lanes.data ?? []).map((l) => l.color),
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const create = useMutation({
    mutationFn: () => api<SwimLane>("/swim-lanes", { method: "POST", body: JSON.stringify({ name, color }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["swimLanes"] });
      setName("");
      // Clear the color override so the NEXT lane starts from a
      // fresh autopick against the updated palette usage.
      resetColor();
    },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<SwimLane> }) => api<SwimLane>(`/swim-lanes/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swimLanes"] }),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api<SwimLane[]>("/swim-lanes/reorder", { method: "POST", body: JSON.stringify({ order: ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["swimLanes"] }),
  });
  const del = useMutation({
    mutationFn: (v: { id: string; reassign_to: string | null }) => api(`/swim-lanes/${v.id}`, { method: "DELETE", body: JSON.stringify({ reassign_to: v.reassign_to }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["swimLanes"] }); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  function handleDragEnd(e: DragEndEvent) {
    if (!lanes.data) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = lanes.data.findIndex((l) => l.id === active.id);
    const newIdx = lanes.data.findIndex((l) => l.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reorderedIds = arrayMove(lanes.data, oldIdx, newIdx).map((l) => l.id);
    reorder.mutate(reorderedIds);
  }

  async function handleDelete(lane: SwimLane) {
    const cardCount = (projects.data ?? []).filter((p) => p.swim_lane_id === lane.id && !p.deleted_at).length;
    const others = (lanes.data ?? []).filter((l) => l.id !== lane.id);
    if (cardCount > 0 && others.length > 0) {
      const target = prompt(
        `${cardCount} card(s) live in "${lane.name}".\nReassign to which lane?\n\n${others.map((l, i) => `${i + 1}. ${l.name}`).join("\n")}\n\nEnter the number of the destination lane:`,
      );
      if (!target) return;
      const idx = Number(target) - 1;
      const dest = others[idx];
      if (!dest) { alert("Invalid selection."); return; }
      del.mutate({ id: lane.id, reassign_to: dest.id });
    } else {
      if (cardCount > 0 && others.length === 0) {
        alert(`"${lane.name}" is the only remaining swim lane and still holds ${cardCount} card(s). Create another lane and reassign these cards before deleting.`);
        return;
      }
      if (!confirm(`Delete "${lane.name}"?`)) return;
      del.mutate({ id: lane.id, reassign_to: null });
    }
  }

  const laneList = lanes.data ?? [];
  const canSortLanes = laneList.length >= 2 && !isAlphabetical(laneList);

  return (
    <section className="card-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Swim lanes</h2>
          <p className="mt-1 text-xs text-wp-slate">Drag to reorder. Deleting a lane with cards will prompt to reassign them.</p>
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={!canSortLanes || reorder.isPending}
          title={
            laneList.length < 2
              ? "Add another lane to enable sorting"
              : !canSortLanes
              ? "Lanes are already in alphabetical order"
              : "Reorder lanes A→Z and save"
          }
          onClick={() => reorder.mutate(alphaSortIdsByName(laneList))}
        >
          <ArrowDownAZ size={13} />
          Sort A→Z
        </button>
      </div>

      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={patch} className="mt-3" />
      <MutationErrorBanner mutation={reorder} className="mt-3" />
      <MutationErrorBanner mutation={del} className="mt-3" />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={(lanes.data ?? []).map((l) => l.id)} strategy={verticalListSortingStrategy}>
          <ul className="mt-3 divide-y divide-wp-stone">
            {lanes.data?.map((lane) => (
              <SortableLaneRow
                key={lane.id}
                lane={lane}
                onToggleTerminal={(v) => patch.mutate({ id: lane.id, body: { is_terminal: v } })}
                onToggleStatus={(v) => patch.mutate({ id: lane.id, body: { requires_weekly_status: v } })}
                onSetDefault={() => patch.mutate({ id: lane.id, body: { is_default_new: true } })}
                onToggleAdminOnly={(v) => patch.mutate({ id: lane.id, body: { is_admin_only: v } })}
                onSetArchive={() => patch.mutate({ id: lane.id, body: { is_archive: true } })}
                onSetPhaseDateKey={(v) => patch.mutate({ id: lane.id, body: { phase_date_key: v } })}
                onRename={(v) => patch.mutate({ id: lane.id, body: { name: v } })}
                onRecolor={(v) => patch.mutate({ id: lane.id, body: { color: v } })}
                onDescribe={(v) => patch.mutate({ id: lane.id, body: { description: v } })}
                onDelete={() => handleDelete(lane)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1 text-xs font-medium text-wp-slate">
          New lane name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Prototype" />
        </label>
        <label className="text-xs font-medium text-wp-slate">
          Color
          <input type="color" className="mt-1 h-8 w-16 cursor-pointer rounded border border-wp-stone" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add lane</button>
      </div>
    </section>
  );
}

function SortableLaneRow(props: {
  lane: SwimLane;
  onToggleTerminal: (v: boolean) => void;
  onToggleStatus: (v: boolean) => void;
  onSetDefault: () => void;
  onToggleAdminOnly: (v: boolean) => void;
  onSetArchive: () => void;
  onSetPhaseDateKey: (v: PhaseDateKey | null) => void;
  onRename: (v: string) => void;
  onRecolor: (v: string) => void;
  onDescribe: (v: string) => void;
  onDelete: () => void;
}) {
  const {
    lane, onToggleTerminal, onToggleStatus, onSetDefault, onToggleAdminOnly,
    onSetArchive, onSetPhaseDateKey, onRename, onRecolor, onDescribe, onDelete,
  } = props;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: lane.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button {...attributes} {...listeners} className="btn-ghost !p-1" aria-label="Drag to reorder"><GripVertical size={14} /></button>
        <input
          type="color"
          className="h-7 w-10 cursor-pointer rounded border border-wp-stone"
          value={lane.color ?? "#94a3b8"}
          onChange={(e) => onRecolor(e.target.value)}
        />
        <input
          className="input min-w-[8rem] flex-1"
          defaultValue={lane.name}
          onBlur={(e) => { if (e.target.value !== lane.name) onRename(e.target.value); }}
        />
        <label
          className="flex items-center gap-1 text-xs text-wp-slate"
          title="New items created from the board land here."
        >
          {/* Radio semantics: promoting one lane demotes the previous default
              server-side (see swim-lanes PATCH). Clicking the currently-set
              lane is a no-op; unset by promoting a different lane instead. */}
          <input
            type="radio"
            name="swim-lane-default-new"
            checked={lane.is_default_new}
            onChange={() => { if (!lane.is_default_new) onSetDefault(); }}
          />
          default for new
        </label>
        <label className="flex items-center gap-1 text-xs text-wp-slate">
          <input type="checkbox" checked={lane.requires_weekly_status} onChange={(e) => onToggleStatus(e.target.checked)} />
          weekly status
        </label>
        <label className="flex items-center gap-1 text-xs text-wp-slate">
          <input type="checkbox" checked={lane.is_terminal} onChange={(e) => onToggleTerminal(e.target.checked)} />
          terminal
        </label>
        <label
          className="flex items-center gap-1 text-xs text-wp-slate"
          title="Hides this lane (and every card in it) from non-admin users."
        >
          <input
            type="checkbox"
            checked={lane.is_admin_only}
            onChange={(e) => onToggleAdminOnly(e.target.checked)}
          />
          admin only
        </label>
        <label
          className="flex items-center gap-1 text-xs text-wp-slate"
          title="Destination for the detail panel's Move-to-archive button. Only one lane at a time."
        >
          {/* Radio semantics like `default for new`: promoting one lane
              demotes the previous archive server-side. */}
          <input
            type="radio"
            name="swim-lane-archive"
            checked={lane.is_archive}
            onChange={() => { if (!lane.is_archive) onSetArchive(); }}
          />
          archive target
        </label>
        <button className="btn-ghost !p-1 text-red-600" aria-label="Delete lane" onClick={onDelete}><Trash2 size={14} /></button>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-3 pl-14 md:grid-cols-[2fr,1fr]">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-wp-slate/70">
            Description
          </label>
          <textarea
            key={`desc-${lane.id}-${lane.updated_at}`}
            className="input mt-1 h-20 w-full resize-y text-sm"
            placeholder="What belongs in this lane? When does a card leave it?"
            defaultValue={lane.description}
            onBlur={(e) => { if (e.target.value !== lane.description) onDescribe(e.target.value); }}
          />
        </div>
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-wp-slate/70">
            Prompt to update
          </label>
          <select
            className="input mt-1 w-full text-sm"
            value={lane.phase_date_key ?? ""}
            onChange={(e) => onSetPhaseDateKey((e.target.value || null) as PhaseDateKey | null)}
          >
            <option value="">— No prompt —</option>
            <option value="target_date">Ready-for-dev date</option>
            <option value="dev_start_date">Development start</option>
            <option value="dev_end_date">Development end</option>
            <option value="optimization_start_date">Post-dev start</option>
            <option value="optimization_end_date">Post-dev end</option>
          </select>
          <p className="mt-1 text-[11px] text-wp-slate/70">
            When set, dragging a card here asks the PM to stamp this date.
          </p>
        </div>
      </div>
    </li>
  );
}

function TeamsAdmin() {
  const teams = useTeams();
  const projects = useProjects();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor, resetColor] = useAutoColor(
    TEAM_PALETTE,
    (teams.data ?? []).map((t) => t.color),
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const create = useMutation({
    mutationFn: () => api<Team>("/teams", { method: "POST", body: JSON.stringify({ name, color }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      setName("");
      resetColor();
    },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<Team> }) => api<Team>(`/teams/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
  // Same optimistic pattern as the swim lanes drag: write the new
  // order into the cache before the network round-trip so the row
  // animates to its final spot without a "snap back" while the
  // POST is in flight. Roll back on error.
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api<Team[]>("/teams/reorder", { method: "POST", body: JSON.stringify({ order: ids }) }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["teams"] });
      const prev = qc.getQueryData<Team[]>(["teams"]);
      if (prev) {
        const byId = new Map(prev.map((t) => [t.id, t]));
        const next = ids.map((id, i) => ({ ...(byId.get(id) as Team), order: i })).filter(Boolean);
        qc.setQueryData<Team[]>(["teams"], next);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["teams"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["teams"] }),
  });
  const del = useMutation({
    mutationFn: (v: { id: string; reassign_to: string | null }) => api(`/teams/${v.id}`, { method: "DELETE", body: JSON.stringify({ reassign_to: v.reassign_to }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["teams"] }); qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  function handleDragEnd(e: DragEndEvent) {
    if (!teams.data) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = teams.data.findIndex((t) => t.id === active.id);
    const newIdx = teams.data.findIndex((t) => t.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reorderedIds = arrayMove(teams.data, oldIdx, newIdx).map((t) => t.id);
    reorder.mutate(reorderedIds);
  }

  async function handleDelete(team: Team) {
    const count = (projects.data ?? []).filter((p) => p.teams.includes(team.id) && !p.deleted_at).length;
    const others = (teams.data ?? []).filter((t) => t.id !== team.id);
    let reassign: string | null = null;
    if (count > 0 && others.length > 0) {
      const target = prompt(
        `${count} project(s) belong to "${team.name}".\nReassign to which team (blank = drop the membership)?\n\n${others.map((t, i) => `${i + 1}. ${t.name}`).join("\n")}\n\nEnter the number, or leave blank:`,
      );
      if (target === null) return;
      if (target.trim()) {
        const idx = Number(target) - 1;
        const dest = others[idx];
        if (!dest) { alert("Invalid selection."); return; }
        reassign = dest.id;
      }
    } else if (!confirm(`Delete "${team.name}"?`)) {
      return;
    }
    del.mutate({ id: team.id, reassign_to: reassign });
  }

  const teamList = teams.data ?? [];
  const canSortTeams = teamList.length >= 2 && !isAlphabetical(teamList);

  return (
    <section className="card-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Teams</h2>
          <p className="mt-1 text-xs text-wp-slate">Cross-functional pods that own or contribute to a project. Drag to reorder — this order controls how groups appear on the Roadmap.</p>
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={!canSortTeams || reorder.isPending}
          title={
            teamList.length < 2
              ? "Add another team to enable sorting"
              : !canSortTeams
              ? "Teams are already in alphabetical order"
              : "Reorder teams A→Z and save"
          }
          onClick={() => reorder.mutate(alphaSortIdsByName(teamList))}
        >
          <ArrowDownAZ size={13} />
          Sort A→Z
        </button>
      </div>
      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={patch} className="mt-3" />
      <MutationErrorBanner mutation={reorder} className="mt-3" />
      <MutationErrorBanner mutation={del} className="mt-3" />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={(teams.data ?? []).map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <ul className="mt-3 divide-y divide-wp-stone">
            {teams.data?.map((t) => (
              <SortableTeamRow
                key={t.id}
                team={t}
                onRecolor={(v) => patch.mutate({ id: t.id, body: { color: v } })}
                onRename={(v) => patch.mutate({ id: t.id, body: { name: v } })}
                onCapacityChange={(v) => patch.mutate({ id: t.id, body: { capacity: v } })}
                onDelete={() => handleDelete(t)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1 text-xs font-medium text-wp-slate">
          New team name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-wp-slate">
          Color
          <input type="color" className="mt-1 h-8 w-16 cursor-pointer rounded border border-wp-stone" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add team</button>
      </div>
    </section>
  );
}

function SortableTeamRow(props: {
  team: Team;
  onRecolor: (v: string) => void;
  onRename: (v: string) => void;
  onCapacityChange: (v: number | null) => void;
  onDelete: () => void;
}) {
  const { team, onRecolor, onRename, onCapacityChange, onDelete } = props;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: team.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-3 py-2">
      <button {...attributes} {...listeners} className="btn-ghost !p-1" aria-label="Drag to reorder"><GripVertical size={14} /></button>
      <input
        type="color"
        className="h-7 w-10 cursor-pointer rounded border border-wp-stone"
        value={team.color}
        onChange={(e) => onRecolor(e.target.value)}
      />
      <input
        key={`name-${team.id}-${team.updated_at}`}
        className="input flex-1"
        defaultValue={team.name}
        onBlur={(e) => { if (e.target.value !== team.name) onRename(e.target.value); }}
      />
      <label className="flex items-center gap-1 text-xs text-wp-slate">
        Cap
        <input
          type="number"
          min={1}
          max={999}
          className="input w-16"
          placeholder="—"
          key={`cap-${team.id}-${team.updated_at}`}
          defaultValue={team.capacity ?? ""}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            const next = raw === "" ? null : Math.max(1, Math.floor(Number(raw)));
            if (next === team.capacity) return;
            if (Number.isNaN(next as number) && next !== null) return;
            onCapacityChange(next);
          }}
        />
      </label>
      <button className="btn-ghost !p-1 text-red-600" aria-label="Delete team" onClick={onDelete}><Trash2 size={14} /></button>
    </li>
  );
}

/**
 * Admin catalog of KPIs. Same shape as TeamsAdmin (create form + list
 * with drag-reorder + inline edit + delete) plus an inline description
 * textarea, since KPI descriptions surface as report-column context on
 * the KPIs tab.
 */
function KpisAdmin() {
  const kpis = useKpis();
  const projects = useProjects();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor, resetColor] = useAutoColor(
    KPI_PALETTE,
    (kpis.data ?? []).map((k) => k.color),
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const create = useMutation({
    mutationFn: () => api<Kpi>("/kpis", {
      method: "POST",
      body: JSON.stringify({ name, description: description.trim() || undefined, color }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kpis"] });
      setName("");
      setDescription("");
      resetColor();
    },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<Kpi> }) =>
      api<Kpi>(`/kpis/${v.id}`, { method: "PATCH", body: JSON.stringify(v.body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kpis"] }),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api<Kpi[]>("/kpis/reorder", { method: "POST", body: JSON.stringify({ order: ids }) }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["kpis"] });
      const prev = qc.getQueryData<Kpi[]>(["kpis"]);
      if (prev) {
        const byId = new Map(prev.map((k) => [k.id, k]));
        const next = ids.map((id, i) => ({ ...(byId.get(id) as Kpi), order: i })).filter(Boolean);
        qc.setQueryData<Kpi[]>(["kpis"], next);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["kpis"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["kpis"] }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/kpis/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kpis"] });
      // Deleting a KPI cascades through project_kpis on the backend, so
      // any project row cached with that KPI id needs to refresh too.
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  function handleDragEnd(e: DragEndEvent) {
    if (!kpis.data) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = kpis.data.findIndex((k) => k.id === active.id);
    const newIdx = kpis.data.findIndex((k) => k.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const nextIds = arrayMove(kpis.data, oldIdx, newIdx).map((k) => k.id);
    reorder.mutate(nextIds);
  }

  function handleDelete(k: Kpi) {
    // Show usage before confirming — KPI deletes are cascade-hard on
    // the backend (all project_kpis rows removed) so PMs deserve a
    // heads-up if the KPI is actively used.
    const count = (projects.data ?? []).filter((p) => p.kpis?.includes(k.id) && !p.deleted_at).length;
    const msg = count > 0
      ? `Delete "${k.name}"? ${count} active project${count === 1 ? "" : "s"} will lose this KPI assignment.`
      : `Delete "${k.name}"?`;
    if (!confirm(msg)) return;
    del.mutate(k.id);
  }

  const kpiList = kpis.data ?? [];
  const canSortKpis = kpiList.length >= 2 && !isAlphabetical(kpiList);

  return (
    <section className="card-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">KPIs</h2>
          <p className="mt-1 text-xs text-wp-slate">
            Outcome buckets projects can subscribe to. Drag to reorder — this order controls how
            KPIs appear on the KPIs report tab.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={!canSortKpis || reorder.isPending}
          title={
            kpiList.length < 2
              ? "Add another KPI to enable sorting"
              : !canSortKpis
              ? "KPIs are already in alphabetical order"
              : "Reorder KPIs A→Z and save"
          }
          onClick={() => reorder.mutate(alphaSortIdsByName(kpiList))}
        >
          <ArrowDownAZ size={13} />
          Sort A→Z
        </button>
      </div>
      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={patch} className="mt-3" />
      <MutationErrorBanner mutation={reorder} className="mt-3" />
      <MutationErrorBanner mutation={del} className="mt-3" />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={(kpis.data ?? []).map((k) => k.id)} strategy={verticalListSortingStrategy}>
          <ul className="mt-3 divide-y divide-wp-stone">
            {kpis.data?.map((k) => (
              <SortableKpiRow
                key={k.id}
                kpi={k}
                onRecolor={(v) => patch.mutate({ id: k.id, body: { color: v } })}
                onRename={(v) => patch.mutate({ id: k.id, body: { name: v } })}
                onRedescribe={(v) => patch.mutate({ id: k.id, body: { description: v } })}
                onDelete={() => handleDelete(k)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="mt-4 grid grid-cols-[1fr_auto_auto] items-end gap-2">
        <label className="text-xs font-medium text-wp-slate">
          New KPI name
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-wp-slate">
          Color
          <input type="color" className="mt-1 h-8 w-16 cursor-pointer rounded border border-wp-stone" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <button className="btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Add KPI</button>
        <label className="col-span-3 text-xs font-medium text-wp-slate">
          Description <span className="text-wp-slate/70">(optional — shown on the KPIs report)</span>
          <textarea
            className="input mt-1 min-h-[3rem]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this KPI measure? Any thresholds to know about?"
          />
        </label>
      </div>
    </section>
  );
}

function SortableKpiRow(props: {
  kpi: Kpi;
  onRecolor: (v: string) => void;
  onRename: (v: string) => void;
  onRedescribe: (v: string) => void;
  onDelete: () => void;
}) {
  const { kpi, onRecolor, onRename, onRedescribe, onDelete } = props;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: kpi.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className="grid grid-cols-[auto_auto_1fr_auto] items-start gap-3 py-3">
      <button {...attributes} {...listeners} className="btn-ghost !p-1" aria-label="Drag to reorder">
        <GripVertical size={14} />
      </button>
      <input
        type="color"
        className="h-7 w-10 cursor-pointer rounded border border-wp-stone"
        value={kpi.color}
        onChange={(e) => onRecolor(e.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <input
          key={`name-${kpi.id}-${kpi.updated_at}`}
          className="input"
          defaultValue={kpi.name}
          onBlur={(e) => { if (e.target.value !== kpi.name) onRename(e.target.value); }}
        />
        <textarea
          key={`desc-${kpi.id}-${kpi.updated_at}`}
          className="input min-h-[2.5rem] text-xs"
          placeholder="What this KPI measures (optional)."
          defaultValue={kpi.description}
          onBlur={(e) => { if (e.target.value !== kpi.description) onRedescribe(e.target.value); }}
        />
      </div>
      <button className="btn-ghost !p-1 text-red-600" aria-label="Delete KPI" onClick={onDelete}><Trash2 size={14} /></button>
    </li>
  );
}

/**
 * T-Shirt sizes admin — the tenant's picker presets (S, M, L, XL,
 * XXL by default) that back the EZEstimates view. Admins can add,
 * rename, re-size, drag-reorder, and delete rows. Shape matches the
 * KpisAdmin surface (create form at the bottom, drag handles on
 * each row, inline delete) so admins get the same muscle memory
 * across every workspace catalog.
 *
 * Validation:
 *   - label must be non-empty (trimmed client-side) and unique
 *     within the tenant. The backend does a case-insensitive dupe
 *     check and returns 409; the mutation error banner surfaces the
 *     message.
 *   - days must be a non-negative integer 0..3650. Zero is allowed
 *     and means "phase_end == phase_start" — a same-day window, not
 *     a "clear the phase" signal.
 *
 * Delete is safe by construction: no schema FK references
 * tshirt_sizes.id (presets are consumed by label lookup via
 * nearestSizeLabel on the backend), so a stray delete can't break a
 * project — just orphans a preset from the picker.
 */
function TshirtSizesAdmin() {
  const sizes = useTshirtSizes();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<string>("7");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Client-side dupe guard so the Add button disables before the
  // user has to eat a round-trip. The backend still enforces the
  // same rule (case-insensitive) as the source of truth.
  const existingLabels = (sizes.data ?? []).map((s) => s.label.toLowerCase());
  const trimmedLabel = label.trim();
  const isDupe = trimmedLabel !== "" && existingLabels.includes(trimmedLabel.toLowerCase());
  const parsedDays = (() => {
    const raw = days.trim();
    if (raw === "") return 7;
    const n = Math.floor(Number(raw));
    if (Number.isNaN(n)) return NaN;
    return Math.max(0, Math.min(3650, n));
  })();
  const daysValid = !Number.isNaN(parsedDays);

  const create = useMutation({
    mutationFn: () =>
      api<TshirtSize>("/tshirt-sizes", {
        method: "POST",
        body: JSON.stringify({ label: trimmedLabel, days: parsedDays }),
      }),
    onMutate: async () => {
      // Optimistic append: the server will overwrite with the real
      // row (canonical id + timestamps) on success. On error the
      // rollback restores the pre-add snapshot.
      await qc.cancelQueries({ queryKey: ["tshirtSizes"] });
      const prev = qc.getQueryData<TshirtSize[]>(["tshirtSizes"]);
      if (prev) {
        const nextPosition = prev.length
          ? Math.max(...prev.map((s) => s.position)) + 1
          : 0;
        const now = new Date().toISOString();
        const optimistic: TshirtSize = {
          id: `optimistic-${now}`,
          label: trimmedLabel,
          days: parsedDays,
          position: nextPosition,
          created_at: now,
          updated_at: now,
        };
        qc.setQueryData<TshirtSize[]>(["tshirtSizes"], [...prev, optimistic]);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["tshirtSizes"], ctx.prev);
    },
    onSuccess: () => {
      setLabel("");
      setDays("7");
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tshirtSizes"] }),
  });

  const patch = useMutation({
    mutationFn: (v: { id: string; body: Partial<Pick<TshirtSize, "label" | "days">> }) =>
      api<TshirtSize>(`/tshirt-sizes/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify(v.body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tshirtSizes"] }),
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api<TshirtSize[]>("/tshirt-sizes/reorder", {
        method: "POST",
        body: JSON.stringify({ order: ids }),
      }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ["tshirtSizes"] });
      const prev = qc.getQueryData<TshirtSize[]>(["tshirtSizes"]);
      if (prev) {
        const byId = new Map(prev.map((s) => [s.id, s]));
        const next = ids
          .map((id, i) => {
            const row = byId.get(id);
            return row ? { ...row, position: i } : null;
          })
          .filter((r): r is TshirtSize => r !== null);
        qc.setQueryData<TshirtSize[]>(["tshirtSizes"], next);
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["tshirtSizes"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tshirtSizes"] }),
  });

  const del = useMutation({
    mutationFn: (id: string) => api(`/tshirt-sizes/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["tshirtSizes"] });
      const prev = qc.getQueryData<TshirtSize[]>(["tshirtSizes"]);
      if (prev) {
        qc.setQueryData<TshirtSize[]>(["tshirtSizes"], prev.filter((s) => s.id !== id));
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["tshirtSizes"], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tshirtSizes"] }),
  });

  function handleDragEnd(e: DragEndEvent) {
    if (!sizes.data) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = sizes.data.findIndex((s) => s.id === active.id);
    const newIdx = sizes.data.findIndex((s) => s.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const nextIds = arrayMove(sizes.data, oldIdx, newIdx).map((s) => s.id);
    reorder.mutate(nextIds);
  }

  function handleDelete(s: TshirtSize) {
    // Same confirm-based prompt style used by lanes / teams / kpis
    // delete. Sizes have no FK dependents (see docblock) so the copy
    // is a plain confirm rather than a reassignment prompt.
    if (!confirm(`Delete size "${s.label}"? It will disappear from the EZEstimates picker.`)) return;
    del.mutate(s.id);
  }

  const rows = sizes.data ?? [];

  return (
    <section className="card-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">T-Shirt Sizes</h2>
          <p className="mt-1 text-xs text-wp-slate">
            Presets available in the EZEstimates size picker. Drag to reorder
            — this order controls how sizes appear in the picker. Days must
            be a non-negative integer (0 is allowed — it sets the phase end
            to match the phase start).
          </p>
        </div>
      </div>

      <MutationErrorBanner mutation={create} className="mt-3" />
      <MutationErrorBanner mutation={patch} className="mt-3" />
      <MutationErrorBanner mutation={reorder} className="mt-3" />
      <MutationErrorBanner mutation={del} className="mt-3" />

      {sizes.isLoading ? (
        <p className="mt-3 text-xs text-wp-slate">Loading sizes…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-xs text-wp-slate">
          No sizes configured yet. Add one below to get started.
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rows.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ul className="mt-3 divide-y divide-wp-stone">
              {rows.map((s) => (
                <SortableTshirtSizeRow
                  key={s.id}
                  size={s}
                  onRename={(v) => patch.mutate({ id: s.id, body: { label: v } })}
                  onResize={(v) => patch.mutate({ id: s.id, body: { days: v } })}
                  onDelete={() => handleDelete(s)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <div className="mt-4 flex items-end gap-2">
        <label className="flex-1 text-xs font-medium text-wp-slate">
          New size label
          <input
            className="input mt-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. XXXL"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                trimmedLabel !== "" &&
                !isDupe &&
                daysValid &&
                !create.isPending
              ) {
                create.mutate();
              }
            }}
          />
        </label>
        <label className="text-xs font-medium text-wp-slate">
          Days
          <input
            type="number"
            min={0}
            max={3650}
            className="input mt-1 w-20"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                trimmedLabel !== "" &&
                !isDupe &&
                daysValid &&
                !create.isPending
              ) {
                create.mutate();
              }
            }}
          />
        </label>
        <button
          className="btn-primary"
          disabled={!trimmedLabel || isDupe || !daysValid || create.isPending}
          title={
            !trimmedLabel
              ? "Enter a label"
              : isDupe
              ? `A size labeled "${trimmedLabel}" already exists`
              : !daysValid
              ? "Days must be a number between 0 and 3650"
              : "Add this size to the picker"
          }
          onClick={() => create.mutate()}
        >
          Add size
        </button>
      </div>
    </section>
  );
}

/**
 * One row in the T-shirt size admin list. Grip on the left, label +
 * days inputs in the middle, delete on the right — mirrors the KPI
 * / team / lane row layout so the whole admin surface stays visually
 * consistent. Both text fields commit on blur (or Enter) to match
 * the "type, click away, saved" idiom used by the rest of the tab.
 */
function SortableTshirtSizeRow({
  size,
  onRename,
  onResize,
  onDelete,
}: {
  size: TshirtSize;
  onRename: (label: string) => void;
  onResize: (days: number) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: size.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-3 py-2">
      <button {...attributes} {...listeners} className="btn-ghost !p-1" aria-label="Drag to reorder">
        <GripVertical size={14} />
      </button>
      <label className="flex flex-1 items-center gap-2 text-xs text-wp-slate">
        Label
        <input
          key={`label-${size.id}-${size.updated_at}`}
          className="input min-w-[6rem] flex-1"
          defaultValue={size.label}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (!next || next === size.label) return;
            onRename(next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-wp-slate">
        Days
        <input
          type="number"
          min={0}
          max={3650}
          key={`days-${size.id}-${size.updated_at}`}
          className="input w-20"
          defaultValue={size.days}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (!raw) return;
            const parsed = Math.floor(Number(raw));
            if (Number.isNaN(parsed)) return;
            const next = Math.max(0, parsed);
            if (next === size.days) return;
            onResize(next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <button
        className="btn-ghost !p-1 text-red-600"
        aria-label="Delete size"
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function UsersAdmin() {
  const users = useUsers();
  const health = useHealth();
  const me = useMe();
  const qc = useQueryClient();
  const isPasswordMode = health.data?.auth === "password";
  const [creating, setCreating] = useState(false);
  const [resettingUser, setResettingUser] = useState<User | null>(null);
  const [viewingUser, setViewingUser] = useState<User | null>(null);
  const patchRole = useMutation({
    mutationFn: (v: { id: string; role: User["role"] }) => api<User>(`/users/${v.id}/role`, { method: "PATCH", body: JSON.stringify({ role: v.role }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const patchCapacity = useMutation({
    mutationFn: (v: { id: string; capacity: number | null }) =>
      api<User>(`/users/${v.id}`, { method: "PATCH", body: JSON.stringify({ capacity: v.capacity }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const delUser = useMutation({
    mutationFn: (id: string) => api<void>(`/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      // Everything the deleted user touched loses its owner / author
      // attribution (SET NULL) so refresh the whole shell rather than
      // just the users list.
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
    },
  });
  const handleDelete = (u: User) => {
    if (
      !confirm(
        `Delete ${u.name} (${u.email})?\n\nThis removes the account and signs them out everywhere. Projects, comments, and history they created are kept but lose their attribution.`,
      )
    ) return;
    delUser.mutate(u.id);
  };
  return (
    <section className="card-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Users &amp; roles</h2>
          <p className="mt-1 text-xs text-wp-slate">
            Capacity is a soft cap on concurrent active (roadmap-scheduled) projects the user owns.
            Leave blank for no cap.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          Create user
        </button>
      </div>
      <MutationErrorBanner mutation={patchRole} className="mt-3" />
      <MutationErrorBanner mutation={patchCapacity} className="mt-3" />
      <MutationErrorBanner mutation={delUser} className="mt-3" />
      <ul className="mt-3 divide-y divide-wp-stone">
        {users.data?.map((u) => (
          <li key={u.id} className="flex items-center gap-3 py-2">
            {/* Identity region — click opens the detail modal. Right-side
                controls (capacity, role, reset, delete) stay independent
                so a stray click on a dropdown doesn't also open the
                dialog. */}
            <button
              type="button"
              onClick={() => setViewingUser(u)}
              className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded p-1 text-left transition hover:bg-wp-stone/40 focus:bg-wp-stone/40 focus:outline-none"
              title="View details and manage group memberships"
            >
              <span
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                style={{ background: u.color }}
              >
                {u.name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-wp-ink">
                  {u.name}
                  {u.is_super_user ? (
                    <span
                      className="rounded bg-wp-red/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-wp-red"
                      title="Super-admin — implicit member of every group"
                    >
                      Super
                    </span>
                  ) : null}
                  {isPasswordMode && !u.password_updated_at ? (
                    <span
                      className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
                      title="This user has no password set and cannot sign in until one is created."
                    >
                      No password
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-wp-slate">{u.email}</div>
              </div>
            </button>
            <label className="flex items-center gap-1 text-xs text-wp-slate">
              Cap
              <input
                type="number"
                min={1}
                max={999}
                className="input w-16"
                placeholder="—"
                key={`cap-${u.id}-${u.updated_at}`}
                defaultValue={u.capacity ?? ""}
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  const next = raw === "" ? null : Math.max(1, Math.floor(Number(raw)));
                  if (next === u.capacity) return;
                  if (Number.isNaN(next as number) && next !== null) return;
                  patchCapacity.mutate({ id: u.id, capacity: next });
                }}
              />
            </label>
            <select
              className="input w-32"
              value={u.role}
              onChange={(e) => patchRole.mutate({ id: u.id, role: e.target.value as User["role"] })}
            >
              <option value="admin">admin</option>
              <option value="owner">owner</option>
              <option value="viewer">viewer</option>
            </select>
            {isPasswordMode ? (
              <button
                type="button"
                className="btn-secondary text-xs"
                onClick={() => setResettingUser(u)}
              >
                Reset password
              </button>
            ) : null}
            {(() => {
              const isSelf = me.data?.id === u.id;
              const isSuper = u.is_super_user;
              const disabled = isSelf || isSuper || delUser.isPending;
              const title = isSelf
                ? "You can't delete your own account"
                : isSuper
                ? "The super-admin can't be deleted"
                : `Delete ${u.name}`;
              return (
                <button
                  type="button"
                  className="btn-ghost !p-1 text-wp-slate hover:text-red-600 disabled:opacity-40 disabled:hover:text-wp-slate"
                  onClick={() => handleDelete(u)}
                  disabled={disabled}
                  aria-label={title}
                  title={title}
                >
                  <Trash2 size={14} />
                </button>
              );
            })()}
          </li>
        ))}
      </ul>

      <UnassignedUsersPanel />

      {creating ? (
        <NewUserDialog
          isPasswordMode={isPasswordMode}
          existingColors={(users.data ?? []).map((u) => u.color).filter((c): c is string => !!c)}
          onClose={() => setCreating(false)}
          onCreated={() => {
            qc.invalidateQueries({ queryKey: ["users"] });
            qc.invalidateQueries({ queryKey: ["unassignedUsers"] });
          }}
        />
      ) : null}
      {resettingUser ? (
        <ResetPasswordDialog
          user={resettingUser}
          onClose={() => setResettingUser(null)}
          onReset={() => qc.invalidateQueries({ queryKey: ["users"] })}
        />
      ) : null}
      {viewingUser ? (
        <UserDetailDialog user={viewingUser} onClose={() => setViewingUser(null)} />
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------
// User detail modal — opens on click of a user row's identity
// region on the Users tab. Shows the basics (email, role,
// capacity, super-admin status) plus a checkbox editor for the
// user's group memberships. Toggling checkboxes maps to the
// existing super-user membership endpoints on the groups router;
// regular admins see the checkboxes disabled with a tooltip
// explaining why (managing tenants is a platform-level concern).
// -----------------------------------------------------------------

function UserDetailDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const me = useMe();
  const groups = useGroups();
  const memberships = useUserGroups(user.id);
  const isSuperUser = useIsSuperUser();
  const qc = useQueryClient();

  const isSelf = me.data?.id === user.id;
  const currentGroupId = me.data?.current_group_id ?? null;

  const membershipSet = useMemo(
    () => new Set((memberships.data ?? []).map((m) => m.group_id)),
    [memberships.data],
  );

  const invalidateAll = () => {
    // Every list that renders "who is in group X" or "which
    // groups user Y is in" needs to refresh after a toggle. Cast
    // wide rather than pick surgical keys — user-group edits are
    // rare, refetches are cheap.
    qc.invalidateQueries({ queryKey: ["userGroups", user.id] });
    qc.invalidateQueries({ queryKey: ["users"] });
    qc.invalidateQueries({ queryKey: ["unassignedUsers"] });
    qc.invalidateQueries({ queryKey: ["groupMembers"] });
  };

  const addMembership = useMutation({
    mutationFn: (groupId: string) =>
      api(`/groups/${groupId}/members`, {
        method: "POST",
        body: JSON.stringify({ user_id: user.id, role: "owner" }),
      }),
    onSuccess: invalidateAll,
  });
  const removeMembership = useMutation({
    mutationFn: (groupId: string) =>
      api(`/groups/${groupId}/members/${user.id}`, { method: "DELETE" }),
    onSuccess: invalidateAll,
  });

  const busy = addMembership.isPending || removeMembership.isPending;
  const canManage = isSuperUser;

  const initials = user.name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("");

  return (
    <DialogFrame title="User details" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold text-white"
            style={{ background: user.color }}
          >
            {initials}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-wp-ink">
              {user.name}
              {user.is_super_user ? (
                <span className="rounded bg-wp-red/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-wp-red">
                  Super-admin
                </span>
              ) : null}
              {isSelf ? (
                <span className="rounded bg-wp-stone px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-wp-slate">
                  You
                </span>
              ) : null}
            </div>
            <div className="truncate text-xs text-wp-slate">{user.email}</div>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-3 rounded-md border border-wp-stone bg-wp-stone/10 p-3 text-xs">
          <div>
            <dt className="font-medium text-wp-slate">Role</dt>
            <dd className="mt-0.5 text-wp-ink">{user.role}</dd>
          </div>
          <div>
            <dt className="font-medium text-wp-slate">Capacity</dt>
            <dd className="mt-0.5 text-wp-ink">{user.capacity ?? "—"}</dd>
          </div>
          <div>
            <dt className="font-medium text-wp-slate">Password set</dt>
            <dd className="mt-0.5 text-wp-ink">
              {user.password_updated_at
                ? new Date(user.password_updated_at).toLocaleDateString()
                : <span className="text-amber-700">never</span>}
            </dd>
          </div>
        </dl>

        <div>
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold text-wp-ink">Groups</h4>
              <p className="mt-0.5 text-xs text-wp-slate">
                {canManage
                  ? "Toggle to add or remove this user from a tenant."
                  : "Managing tenant memberships requires super-admin. This is a read-only view."}
                {user.is_super_user
                  ? " Super-admins are implicit members of every group."
                  : ""}
              </p>
            </div>
          </div>

          <MutationErrorBanner mutation={addMembership} className="mt-2" />
          <MutationErrorBanner mutation={removeMembership} className="mt-2" />

          {memberships.isLoading || groups.isLoading ? (
            <div className="mt-3 text-xs text-wp-slate">Loading…</div>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {(groups.data ?? []).map((g) => {
                const isMember = membershipSet.has(g.id);
                const isImplicit = user.is_super_user;
                const wouldLockOutSelf = isSelf && isMember && g.id === currentGroupId;
                const disabledReason = !canManage
                  ? "Requires super-admin"
                  : isImplicit
                  ? "Super-admins are implicit members and can't be removed"
                  : wouldLockOutSelf
                  ? "You can't remove yourself from the group you're currently viewing"
                  : busy
                  ? "Please wait…"
                  : null;
                return (
                  <li key={g.id} className="flex items-center gap-2 rounded border border-wp-stone bg-white p-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-wp-red"
                      checked={isMember || isImplicit}
                      disabled={disabledReason !== null}
                      onChange={(e) => {
                        if (disabledReason) return;
                        if (e.target.checked) addMembership.mutate(g.id);
                        else removeMembership.mutate(g.id);
                      }}
                      title={disabledReason ?? (isMember ? "Remove from group" : "Add to group")}
                    />
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: g.color ?? "#94a3b8" }}
                    />
                    <span className="flex-1 text-sm text-wp-ink">{g.name}</span>
                    {disabledReason ? (
                      <span className="text-[11px] text-wp-slate" title={disabledReason}>
                        {isImplicit ? "implicit" : wouldLockOutSelf ? "current" : "locked"}
                      </span>
                    ) : null}
                  </li>
                );
              })}
              {(groups.data ?? []).length === 0 ? (
                <li className="text-xs text-wp-slate">No groups visible.</li>
              ) : null}
            </ul>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}

// -----------------------------------------------------------------
// Unassigned users — rescue orphaned accounts that have no
// group memberships (would otherwise be invisible to every admin
// yet still hold their email against re-creation). Shows up on
// the Users tab so the discovery path is the same as the one that
// triggered the confusion in the first place ("I tried to invite
// someone and it said the email exists — where are they?").
// -----------------------------------------------------------------

function UnassignedUsersPanel() {
  const unassigned = useUnassignedUsers();
  const me = useMe();
  const qc = useQueryClient();
  // Per-row role selection. Defaults to "owner" — matches the
  // default role in NewUserDialog so this feels like the same
  // "add someone" affordance.
  const [roleById, setRoleById] = useState<Map<string, Role>>(() => new Map());

  const currentGroupName = me.data?.memberships?.find(
    (m) => m.group_id === me.data?.current_group_id,
  )?.name;

  const add = useMutation({
    mutationFn: (v: { id: string; role: Role }) =>
      api<{ user: User; role: Role }>(`/users/${v.id}/groups`, {
        method: "POST",
        body: JSON.stringify({ role: v.role }),
      }),
    onSuccess: () => {
      // Both lists move: the rescued user leaves `unassignedUsers`
      // and joins the group-scoped `users` roster in the same tick.
      qc.invalidateQueries({ queryKey: ["unassignedUsers"] });
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });

  // Nothing to show if the query hasn't loaded yet OR there are
  // legitimately zero orphans — keep the panel out of the DOM in
  // that case so it doesn't clutter the usual (healthy) tab.
  if (!unassigned.data || unassigned.data.length === 0) return null;

  return (
    <div className="mt-6 rounded-md border border-amber-300 bg-amber-50/50 p-4">
      <h3 className="text-sm font-semibold text-amber-900">
        Unassigned users ({unassigned.data.length})
      </h3>
      <p className="mt-0.5 text-xs text-amber-900/80">
        These accounts exist but aren&apos;t members of any group, so they can&apos;t sign in or be
        assigned as owners. Add them to <strong>{currentGroupName ?? "the current group"}</strong> to
        make them usable here.
      </p>

      <MutationErrorBanner mutation={add} className="mt-3" />

      <ul className="mt-3 divide-y divide-amber-200/70">
        {unassigned.data.map((u) => {
          const role = roleById.get(u.id) ?? "owner";
          return (
            <li key={u.id} className="flex items-center gap-3 py-2">
              <span
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                style={{ background: u.color }}
              >
                {u.name.split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-wp-ink">{u.name}</div>
                <div className="text-xs text-wp-slate">{u.email}</div>
              </div>
              <select
                className="input w-28"
                value={role}
                onChange={(e) => {
                  const next = new Map(roleById);
                  next.set(u.id, e.target.value as Role);
                  setRoleById(next);
                }}
              >
                <option value="admin">admin</option>
                <option value="owner">owner</option>
                <option value="viewer">viewer</option>
              </select>
              <button
                type="button"
                className="btn-primary text-xs"
                disabled={add.isPending}
                onClick={() => add.mutate({ id: u.id, role })}
              >
                Add to {currentGroupName ?? "group"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------
// Create user
// -----------------------------------------------------------------

function NewUserDialog({
  isPasswordMode,
  existingColors,
  onClose,
  onCreated,
}: {
  isPasswordMode: boolean;
  /** Colors already used by existing users in this group — feeds the
   *  autopicker so the default color for a new user doesn't collide
   *  with an existing avatar. */
  existingColors: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<User["role"]>("owner");
  const [color, setColor] = useAutoColor(USER_PALETTE, existingColors);
  const [capacity, setCapacity] = useState<string>("3");
  const [password, setPassword] = useState("");
  // The response includes generated_password exactly once. Cache it
  // here so the reveal card can render before the dialog is closed.
  const [reveal, setReveal] = useState<{ password: string; email: string } | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const capNum = capacity.trim() === "" ? null : Math.max(1, Math.floor(Number(capacity)));
      const body: Record<string, unknown> = {
        email: email.trim(),
        name: name.trim(),
        role,
        color,
        capacity: Number.isFinite(capNum as number) ? capNum : 3,
      };
      if (isPasswordMode) {
        body.password = password;
      }
      return api<{ user: User; generated_password?: string }>("/users", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (res) => {
      onCreated();
      if (res.generated_password) {
        setReveal({ password: res.generated_password, email: res.user.email });
      } else {
        // No password (mock mode) → nothing to reveal, just close.
        onClose();
      }
    },
  });

  // Reveal-mode UI: same dialog frame, but showing the one-time
  // password + a single Close action.
  if (reveal) {
    return (
      <DialogFrame onClose={onClose} title="User created">
        <RevealPasswordCard password={reveal.password} email={reveal.email} variant="created" />
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </DialogFrame>
    );
  }

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const nameValid = name.trim().length > 0;
  const passwordValid = !isPasswordMode || passwordIsValid(password, email);
  const canSubmit = emailValid && nameValid && passwordValid && !create.isPending;

  return (
    <DialogFrame onClose={onClose} title="Create user">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          create.mutate();
        }}
        className="space-y-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-wp-slate">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              className="input mt-1 w-full"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-wp-slate">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input mt-1 w-full"
            />
          </label>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-wp-slate">Role</span>
            <select
              className="input mt-1 w-full"
              value={role}
              onChange={(e) => setRole(e.target.value as User["role"])}
            >
              <option value="admin">admin</option>
              <option value="owner">owner</option>
              <option value="viewer">viewer</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-wp-slate">Capacity</span>
            <input
              type="number"
              min={1}
              max={999}
              placeholder="3"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              className="input mt-1 w-full"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-wp-slate">Color</span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {USER_PALETTE.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`h-6 w-6 rounded-full border ${color === c ? "ring-2 ring-wp-red ring-offset-1" : "border-wp-stone"}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Pick ${c}`}
                />
              ))}
            </div>
          </label>
        </div>

        {isPasswordMode ? (
          <div>
            <div className="mb-1 text-xs font-medium text-wp-slate">Password</div>
            <PasswordField value={password} onChange={setPassword} email={email} />
          </div>
        ) : (
          <p className="rounded-md border border-wp-stone bg-wp-stone/20 px-3 py-2 text-xs text-wp-slate">
            The server is running in mock auth mode, so no password is required.
          </p>
        )}

        <MutationErrorBanner mutation={create} />

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {create.isPending ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

// -----------------------------------------------------------------
// Reset password
// -----------------------------------------------------------------

function ResetPasswordDialog({
  user,
  onClose,
  onReset,
}: {
  user: User;
  onClose: () => void;
  onReset: () => void;
}) {
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: () =>
      api<{ user: User; generated_password: string }>(`/users/${user.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    onSuccess: (res) => {
      onReset();
      setReveal(res.generated_password);
    },
  });

  if (reveal) {
    return (
      <DialogFrame onClose={onClose} title={`Password reset for ${user.name}`}>
        <RevealPasswordCard password={reveal} email={user.email} variant="reset" />
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </DialogFrame>
    );
  }

  const passwordValid = passwordIsValid(password, user.email);
  const canSubmit = passwordValid && !reset.isPending;

  return (
    <DialogFrame onClose={onClose} title={`Reset password for ${user.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          reset.mutate();
        }}
        className="space-y-4"
      >
        <p className="text-xs text-wp-slate">
          Choose or generate a new password for <span className="font-mono">{user.email}</span>.
          Any active sessions will be signed out immediately after the reset.
        </p>
        <div>
          <div className="mb-1 text-xs font-medium text-wp-slate">New password</div>
          <PasswordField value={password} onChange={setPassword} email={user.email} autoFocus />
        </div>
        <MutationErrorBanner mutation={reset} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {reset.isPending ? "Resetting…" : "Reset password"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

// -----------------------------------------------------------------
// Groups (multi-tenancy) — super-user only
// -----------------------------------------------------------------

/**
 * CRUD for the tenants themselves, plus per-group membership
 * assignments. Only rendered inside the Admin panel when the caller
 * is a super-user (the tab is filtered out otherwise). See
 * migration 017 and backend/src/routes/groups.ts for the wire
 * shape.
 */
function GroupsAdmin() {
  const groups = useGroups();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-wp-ink">Groups</h2>
          <p className="text-xs text-wp-slate">
            One tenant workspace per group. Projects, swim lanes,
            teams, and KPIs are isolated within each. Only super-users
            can create or delete groups.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>
          Add group
        </button>
      </div>

      <div className="card-surface divide-y divide-wp-stone">
        {groups.data?.length === 0 ? (
          <div className="p-4 text-sm text-wp-slate">No groups yet.</div>
        ) : null}
        {groups.data?.map((g) => (
          <GroupRow
            key={g.id}
            group={g}
            expanded={expandedId === g.id}
            onToggle={() => setExpandedId((cur) => (cur === g.id ? null : g.id))}
          />
        ))}
      </div>

      {showCreate ? (
        <CreateGroupDialog
          existingColors={(groups.data ?? []).map((g) => g.color).filter((c): c is string => !!c)}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * One row per group. Collapsed: name + color + delete. Expanded:
 * inline member table with add-member + role-change + remove
 * controls. Kept as a single component because the state is small
 * and lifting it doesn't buy readability.
 */
function GroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: Group;
  expanded: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(group.name);
  const [color, setColor] = useState<string>(group.color ?? "#64748B");

  const rename = useMutation({
    mutationFn: (patch: { name?: string; color?: string }) =>
      api<Group>(`/groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });

  const remove = useMutation({
    mutationFn: () =>
      api(`/groups/${group.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups"] }),
  });

  const commitRename = () => {
    if (name.trim() && name.trim() !== group.name) {
      rename.mutate({ name: name.trim() });
    }
  };
  const commitColor = (next: string) => {
    setColor(next);
    if (next !== (group.color ?? "#64748B")) rename.mutate({ color: next });
  };

  return (
    <div className="p-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="text-wp-slate hover:text-wp-ink"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <svg viewBox="0 0 12 12" className={`h-3 w-3 transition ${expanded ? "rotate-90" : ""}`}>
            <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <input
          type="color"
          value={color}
          onChange={(e) => commitColor(e.target.value)}
          className="h-6 w-8 cursor-pointer rounded border border-wp-stone"
          aria-label={`Color for ${group.name}`}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setName(group.name);
          }}
          className="flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-wp-ink hover:border-wp-stone focus:border-wp-red focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete group "${group.name}"? This is only allowed if it has no active projects.`)) {
              remove.mutate();
            }
          }}
          className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-red-600"
          aria-label={`Delete ${group.name}`}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {remove.isError ? (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {(remove.error as Error).message}
        </div>
      ) : null}

      {expanded ? <GroupMembersPanel groupId={group.id} /> : null}
    </div>
  );
}

/**
 * Members table for a single group. Each row shows the user, their
 * role in this group, and a remove control. Adding uses a
 * dropdown-driven form at the bottom so the "unassigned" users are
 * discoverable without opening a modal.
 */
function GroupMembersPanel({ groupId }: { groupId: string }) {
  const users = useUsers();
  const members = useGroupMembers(groupId);
  const qc = useQueryClient();

  const setRole = useMutation({
    mutationFn: (args: { userId: string; role: Role }) =>
      api(`/groups/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: args.userId, role: args.role }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groupMembers", groupId] });
      // Someone might have just changed their OWN role — refetch me
      // so the navbar/admin gates re-evaluate.
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) =>
      api(`/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groupMembers", groupId] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  const [addUserId, setAddUserId] = useState<string>("");
  const [addRole, setAddRole] = useState<Role>("owner");

  const memberIds = new Set(members.data?.map((m) => m.user_id) ?? []);
  const eligible = (users.data ?? []).filter((u) => !memberIds.has(u.id));

  return (
    <div className="mt-3 rounded-md border border-wp-stone bg-wp-stone/20 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-wp-slate">
        Members ({members.data?.length ?? 0})
      </div>

      {members.isLoading ? (
        <div className="text-xs text-wp-slate">Loading…</div>
      ) : (
        <ul className="space-y-1">
          {members.data?.map((m) => (
            <li key={m.user_id} className="flex items-center gap-2 rounded-md bg-white px-2 py-1.5">
              <span className="flex-1 truncate text-sm text-wp-ink">
                {m.name} <span className="text-xs text-wp-slate">({m.email})</span>
              </span>
              <select
                value={m.role}
                onChange={(e) => setRole.mutate({ userId: m.user_id, role: e.target.value as Role })}
                disabled={setRole.isPending}
                className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs"
                aria-label={`Role for ${m.name}`}
              >
                <option value="admin">admin</option>
                <option value="owner">owner</option>
                <option value="viewer">viewer</option>
              </select>
              <button
                type="button"
                onClick={() => removeMember.mutate(m.user_id)}
                className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-red-600"
                aria-label={`Remove ${m.name}`}
                title="Remove from group"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
          {members.data?.length === 0 ? (
            <li className="text-xs text-wp-slate">No members yet.</li>
          ) : null}
        </ul>
      )}

      {removeMember.isError ? (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {(removeMember.error as Error).message}
        </div>
      ) : null}

      {/* Add-member row — hidden entirely when every user is already a
          member of this group. */}
      {eligible.length > 0 ? (
        <div className="mt-3 flex items-center gap-2 border-t border-wp-stone pt-3">
          <select
            value={addUserId}
            onChange={(e) => setAddUserId(e.target.value)}
            className="flex-1 rounded-md border border-wp-stone bg-white px-2 py-1 text-xs"
          >
            <option value="">Add a user…</option>
            {eligible.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
          <select
            value={addRole}
            onChange={(e) => setAddRole(e.target.value as Role)}
            className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs"
          >
            <option value="admin">admin</option>
            <option value="owner">owner</option>
            <option value="viewer">viewer</option>
          </select>
          <button
            type="button"
            disabled={!addUserId || setRole.isPending}
            onClick={() => {
              setRole.mutate(
                { userId: addUserId, role: addRole },
                { onSuccess: () => setAddUserId("") },
              );
            }}
            className="btn-secondary text-xs"
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CreateGroupDialog({
  existingColors,
  onClose,
}: {
  /** Colors already assigned to existing groups — used so the
   *  default color for a new group doesn't collide with the sibling
   *  tenants a super-user is looking at in the switcher. */
  existingColors: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useAutoColor(GROUP_PALETTE, existingColors);

  const create = useMutation({
    mutationFn: () =>
      api<Group>("/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groups"] });
      // The new group auto-enrolls every super-user, so /me's
      // memberships list may have grown — refetch so the navbar
      // switcher immediately shows the new tenant.
      qc.invalidateQueries({ queryKey: ["me"] });
      onClose();
    },
  });

  return (
    <DialogFrame title="New group" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="space-y-3"
      >
        <div>
          <label className="mb-1 block text-xs font-medium text-wp-slate">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-wp-stone px-2.5 py-1.5 text-sm"
            placeholder="e.g. ShopAtHome"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-wp-slate">Color</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-8 w-14 cursor-pointer rounded border border-wp-stone"
          />
        </div>
        <p className="rounded-md border border-wp-stone bg-wp-stone/20 px-3 py-2 text-xs text-wp-slate">
          The new group is seeded with default swim lanes (Backlog,
          Ready for Dev, In Dev, Complete, Archive) and every current
          super-user is auto-enrolled as admin. Add per-tenant users
          from the expanded row after it's created.
        </p>
        <MutationErrorBanner mutation={create} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Create group"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

// -----------------------------------------------------------------
// Dialog frame — thin wrapper to avoid pulling in Radix Dialog just
// for two admin flows. The Kanban already has its own modal system;
// this is intentionally the "cheap self-contained" alternative.
// -----------------------------------------------------------------

function DialogFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-surface w-full max-w-lg p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-wp-ink">{title}</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-wp-ink"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
