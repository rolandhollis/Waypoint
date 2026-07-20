import { useMemo, useState } from "react";
import { differenceInCalendarDays, format, formatDistanceToNowStrict, parseISO } from "date-fns";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import { AuditEventBody, auditActorLabel, recentEventToRenderEntry } from "../lib/auditRender";
import { useKpis, useProjects, useSwimLanes, useTeams, useUsers } from "../lib/queries";
import { indexById } from "../lib/hierarchy";
import type { RecentAuditEvent } from "../lib/types";
import { useViewStore } from "../lib/viewState";
import { cn } from "../lib/cn";
import { Collapsible } from "./Collapsible";

/**
 * Roadmap's "Recent changes (last 7 days)" panel — sits between the
 * Gantt timeline and the Unscheduled list.
 *
 * Three-level expand/collapse:
 *   1. Section (default expanded)  → collapses the whole panel to a
 *      one-line header showing `N changes across M items`.
 *   2. Group (default collapsed)   → one group per root-epic rollup.
 *      Header shows the epic title plus a count; body is the
 *      event list, sorted newest-first.
 *   3. Entry (default collapsed)   → each event is a compact
 *      one-liner (relative time + who + short description).
 *      Clicking expands to show the absolute timestamp and a link
 *      to the affected project.
 *
 * Expand state is component-local (three `Set<string>` refs, one per
 * level) — deliberately NOT persisted; a fresh Roadmap mount starts
 * clean so users aren't confused by pre-opened state after
 * navigating away and back.
 *
 * Zero-events case still renders the section header so the empty
 * state is informative rather than absent.
 */
export function RecentChanges({
  events,
  days = 7,
  truncated = false,
  onOpenProject,
  visibleProjectIds,
}: {
  events: RecentAuditEvent[];
  days?: number;
  truncated?: boolean;
  /**
   * Optional handler: when supplied, clicking an entry's project
   * title in the expanded view opens that project's detail panel
   * (Roadmap's existing `selectedId` state). Left optional so the
   * component can be used in read-only contexts too.
   */
  onOpenProject?: (id: string) => void;
  /**
   * Optional whitelist of project ids the panel is allowed to show.
   * Events whose `project_id` is not in this set are dropped before
   * grouping/counting so the roadmap can hide activity for lanes it
   * excludes from the rest of the view (Archive, Parking Lot).
   * Omit the prop to show every event.
   */
  visibleProjectIds?: ReadonlySet<string>;
}) {
  const lanes = useSwimLanes();
  const teams = useTeams();
  const users = useUsers();
  const kpis = useKpis();
  const projects = useProjects();
  const projectsById = useMemo(() => indexById(projects.data ?? []), [projects.data]);

  // Section-level open state is a shared roadmap UI pref persisted
  // in the zustand view store, so reloading the roadmap remembers
  // the user's "keep it closed" preference. Default from the store
  // is false — the panel is a "peek in when you need it" rather than
  // something that should push the Unscheduled list off the screen
  // on every roadmap open.
  const sectionOpen = useViewStore((s) => s.roadmapRecentChangesOpen);
  const setSectionOpen = useViewStore((s) => s.setRoadmapRecentChangesOpen);

  // Per-group open state. Sets contain root_epic_id values that are
  // currently EXPANDED. Default state is empty → every group starts
  // collapsed so the panel doesn't overwhelm on first mount; users
  // open the specific epics they care about.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openEntries, setOpenEntries] = useState<Set<string>>(new Set());

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Apply the caller-supplied project whitelist first so every
  // downstream number (group count, event count, empty-state copy)
  // matches what actually renders.
  const visibleEvents = useMemo(() => {
    if (!visibleProjectIds) return events;
    return events.filter((e) => visibleProjectIds.has(e.project_id));
  }, [events, visibleProjectIds]);

  // Group events by root_epic_id, then sort:
  //   * Groups alphabetically by root-epic title (case-insensitive),
  //     with id as a stable tiebreaker for duplicate titles.
  //   * Entries inside each group reverse-chronologically (newest
  //     first) — the server already sorts DESC, but re-sort defensively
  //     in case the payload was reordered upstream.
  const groups = useMemo(() => {
    const byRoot = new Map<string, { title: string; events: RecentAuditEvent[] }>();
    for (const e of visibleEvents) {
      const existing = byRoot.get(e.root_epic_id);
      if (existing) {
        existing.events.push(e);
      } else {
        byRoot.set(e.root_epic_id, { title: e.root_epic_title, events: [e] });
      }
    }
    const list = Array.from(byRoot.entries()).map(([id, v]) => ({
      root_epic_id: id,
      root_epic_title: v.title,
      events: v.events.slice().sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)),
    }));
    list.sort((a, b) => {
      const t = a.root_epic_title.toLowerCase().localeCompare(b.root_epic_title.toLowerCase());
      if (t !== 0) return t;
      return a.root_epic_id.localeCompare(b.root_epic_id);
    });
    return list;
  }, [visibleEvents]);

  // Per-group visual annotations for the header row: a "NEW" badge when
  // the root epic itself was created inside the current window, and a
  // slip-direction arrow when the epic's completion date (whichever of
  // optimization_end_date / dev_end_date / target_date) has net-moved
  // over the same window. Pre-computed once here so the header render
  // stays O(1) per group and doesn't repeat the scan on every render.
  const groupMeta = useMemo(() => {
    const meta = new Map<string, GroupMeta>();
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const g of groups) {
      const project = projectsById.get(g.root_epic_id);
      let isNew = false;
      if (project) {
        const created = Date.parse(project.created_at);
        if (Number.isFinite(created) && created >= cutoffMs) {
          isNew = true;
        }
      }
      meta.set(g.root_epic_id, { isNew, slip: computeSlip(g.events) });
    }
    return meta;
  }, [groups, projectsById, days]);

  const totalEvents = visibleEvents.length;
  const totalItems = groups.length;

  return (
    <section className="border-t border-wp-stone bg-wp-bg/60 px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setSectionOpen(!sectionOpen)}
        aria-expanded={sectionOpen}
      >
        <ChevronRight
          size={14}
          className={cn(
            "text-wp-slate transition-transform duration-200 ease-out motion-reduce:transition-none",
            sectionOpen && "rotate-90",
          )}
        />
        <h3 className="text-sm font-semibold text-wp-ink">
          Recent changes{" "}
          <span className="font-normal text-wp-slate">(last {days} {days === 1 ? "day" : "days"})</span>
        </h3>
        <span className="text-xs text-wp-slate">
          {totalEvents === 0
            ? "— No changes in the last " + (days === 1 ? "day" : `${days} days`)
            : `— ${totalEvents} change${totalEvents === 1 ? "" : "s"} across ${totalItems} item${totalItems === 1 ? "" : "s"}`}
          {truncated ? " (older activity truncated)" : ""}
        </span>
      </button>

      <Collapsible open={sectionOpen && totalEvents > 0}>
        <ul className="mt-2 space-y-1">
          {groups.map((g) => {
            const isOpen = openGroups.has(g.root_epic_id);
            const meta = groupMeta.get(g.root_epic_id);
            const slip = meta?.slip ?? null;
            return (
              <li key={g.root_epic_id} className="rounded border border-wp-stone bg-white">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                  onClick={() => toggle(setOpenGroups, g.root_epic_id)}
                  aria-expanded={isOpen}
                >
                  <ChevronRight
                    size={12}
                    className={cn(
                      "text-wp-slate transition-transform duration-200 ease-out motion-reduce:transition-none",
                      isOpen && "rotate-90",
                    )}
                  />
                  {meta?.isNew ? (
                    <span
                      className="inline-flex shrink-0 items-center rounded border border-emerald-300 bg-emerald-100 px-1 py-px text-[10px] font-bold uppercase tracking-wide text-emerald-700"
                      aria-hidden="true"
                    >
                      NEW
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm text-wp-ink">
                    {g.root_epic_title}
                  </span>
                  {slip ? (
                    <span
                      className="inline-flex shrink-0 items-center"
                      title={slipTooltip(slip)}
                      aria-hidden="true"
                    >
                      {slip.direction === "forward" ? (
                        <ArrowRight size={12} className="text-red-600" />
                      ) : (
                        <ArrowLeft size={12} className="text-emerald-600" />
                      )}
                    </span>
                  ) : null}
                  <span className="text-[11px] text-wp-slate">
                    {g.events.length} change{g.events.length === 1 ? "" : "s"}
                  </span>
                </button>
                <Collapsible open={isOpen}>
                  <ol className="border-t border-wp-stone/60 px-2 py-1.5">
                    {g.events.map((e) => {
                      const entryOpen = openEntries.has(e.id);
                      const who = auditActorLabel(e, users.data ?? []);
                      // `Date.parse` is enough for the ISO strings the
                      // backend emits; formatDistanceToNowStrict gives a
                      // compact "3h" / "2d" style relative label.
                      const occurred = new Date(e.occurred_at);
                      const relative = formatDistanceToNowStrict(occurred, { addSuffix: true });
                      const absolute = format(occurred, "yyyy-MM-dd HH:mm");
                      return (
                        <li key={e.id} className="border-b border-wp-stone/40 last:border-b-0">
                          <button
                            type="button"
                            className="flex w-full items-start gap-2 py-1.5 text-left text-xs"
                            onClick={() => toggle(setOpenEntries, e.id)}
                            aria-expanded={entryOpen}
                          >
                            <ChevronRight
                              size={11}
                              className={cn(
                                "mt-0.5 shrink-0 text-wp-slate transition-transform duration-200 ease-out motion-reduce:transition-none",
                                entryOpen && "rotate-90",
                              )}
                            />
                            <span className="min-w-0 flex-1 leading-relaxed">
                              <span className="tabular-nums text-wp-slate/80" title={absolute}>
                                {relative}
                              </span>
                              {" · "}
                              <span className="text-wp-slate">{who}</span>{" "}
                              <AuditEventBody
                                entry={recentEventToRenderEntry(e)}
                                lanes={lanes.data ?? []}
                                teams={teams.data ?? []}
                                users={users.data ?? []}
                                kpis={kpis.data ?? []}
                                projectsById={projectsById}
                              />
                              {e.in_archive ? (
                                <span
                                  className="ml-1 inline-flex items-center rounded bg-wp-stone/60 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-wp-slate"
                                  title="This project currently sits in the Archive lane"
                                >
                                  archived
                                </span>
                              ) : null}
                            </span>
                          </button>
                          <Collapsible open={entryOpen}>
                            <div className="ml-5 pb-2 text-[11px] text-wp-slate">
                              <div>
                                <span className="text-wp-slate/70">When:</span>{" "}
                                <span className="tabular-nums text-wp-ink">{absolute}</span>
                              </div>
                              <div className="mt-0.5">
                                <span className="text-wp-slate/70">Project:</span>{" "}
                                {onOpenProject ? (
                                  <button
                                    type="button"
                                    className="text-wp-ink hover:underline"
                                    onClick={(ev) => {
                                      // Prevent the surrounding row toggle from
                                      // collapsing the entry when the user clicks
                                      // the project link.
                                      ev.stopPropagation();
                                      onOpenProject(e.project_id);
                                    }}
                                    title={`Open ${e.project_title}`}
                                  >
                                    {e.project_title}
                                  </button>
                                ) : (
                                  <span className="text-wp-ink">{e.project_title}</span>
                                )}
                              </div>
                              {/* Raw before → after for values that don't
                                  render inline (e.g. cleared description).
                                  Skipped when both are blank so we don't
                                  show noise for create/archive/restore. */}
                              {renderRawValues(e)}
                            </div>
                          </Collapsible>
                        </li>
                      );
                    })}
                  </ol>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      </Collapsible>
    </section>
  );
}

/**
 * Best-effort JSON preview of the raw `from_value` / `to_value` on an
 * event, shown only when the values carry meaningful content the
 * inline audit renderer intentionally elides (e.g. description body,
 * long note strings). Skipped entirely for events without any raw
 * payload — nothing to add over the one-liner in that case.
 */
function renderRawValues(e: RecentAuditEvent): React.ReactNode {
  const rawFrom = stringifyValue(e.from_value);
  const rawTo = stringifyValue(e.to_value);
  if (!rawFrom && !rawTo) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-wp-slate/70 hover:text-wp-slate">Raw values</summary>
      <div className="mt-1 grid gap-1">
        {rawFrom ? (
          <div>
            <span className="text-wp-slate/70">From:</span>{" "}
            <code className="whitespace-pre-wrap break-words text-[10px] text-wp-ink">{rawFrom}</code>
          </div>
        ) : null}
        {rawTo ? (
          <div>
            <span className="text-wp-slate/70">To:</span>{" "}
            <code className="whitespace-pre-wrap break-words text-[10px] text-wp-ink">{rawTo}</code>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * Fields that count as "completion date" for slip detection. Order
 * mirrors the roadmap end-date precedence: post-dev > dev > discovery.
 * All three roll into a single net-direction indicator on the group
 * header — we don't distinguish which of the three moved.
 */
const COMPLETION_DATE_FIELDS: ReadonlySet<string> = new Set([
  "optimization_end_date",
  "dev_end_date",
  "target_date",
]);

type SlipInfo = {
  direction: "forward" | "backward";
  from: Date;
  to: Date;
  days: number;
};

type GroupMeta = {
  isNew: boolean;
  slip: SlipInfo | null;
};

/**
 * Given the recent-window events for a single root epic, compute the
 * net movement of its completion date. Only `action: "update"` rows on
 * the three completion-date fields count — add/remove/move don't carry
 * a directional signal. Events are sorted ASC by `occurred_at`; the
 * first event's `from_value` and the last event's `to_value` bracket
 * the window's net change. Returns null when there's no valid
 * before/after pair or when the two are equal (net-zero).
 */
function computeSlip(events: RecentAuditEvent[]): SlipInfo | null {
  const dateEvents = events.filter(
    (e) => e.action === "update" && e.field != null && COMPLETION_DATE_FIELDS.has(e.field),
  );
  const sorted = dateEvents.slice().sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return null;
  const from = parseIsoDate(first.from_value);
  const to = parseIsoDate(last.to_value);
  if (!from || !to) return null;
  const diffMs = to.getTime() - from.getTime();
  if (diffMs === 0) return null;
  return {
    direction: diffMs > 0 ? "forward" : "backward",
    from,
    to,
    days: Math.abs(differenceInCalendarDays(to, from)),
  };
}

function parseIsoDate(v: unknown): Date | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const d = parseISO(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function slipTooltip(slip: SlipInfo): string {
  const fromLabel = format(slip.from, "MMM d");
  const toLabel = format(slip.to, "MMM d");
  const dayWord = slip.days === 1 ? "day" : "days";
  const suffix = slip.direction === "forward" ? "later" : "earlier";
  return `Completion date moved from ${fromLabel} → ${toLabel} (${slip.days} ${dayWord} ${suffix})`;
}

function stringifyValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v, null, 2);
    if (!s || s === "null" || s === "[]" || s === "{}") return null;
    return s;
  } catch {
    return null;
  }
}
