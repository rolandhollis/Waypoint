import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";
import type { DeadlineStatus } from "../lib/deadlines";
import type { DependencyStatus } from "../lib/dependencies";
import type { ViolationDelta } from "../lib/violations";

/** How many examples to inline per violation category. Overflow
 *  is collapsed into a "+ N more" tail so the toast never grows
 *  unbounded when a shift breaks many upstream deps at once. */
const MAX_EXAMPLES_PER_KIND = 3;

/** Auto-dismiss delay in ms. Long enough to read two lines of
 *  amber prose without feeling permanent; user can also click the
 *  × to close early. */
const AUTO_DISMISS_MS = 8000;

/**
 * Post-mutation warning banner that appears immediately below an
 * EZEstimates row when a phase-size pick (manual or Claude-accept)
 * introduced a NEW deadline or dependency violation — or worsened
 * an existing one. Purely informational; the PATCH has already
 * landed by the time this renders, and the spec is explicit that
 * the warning must not block the change.
 *
 * The banner auto-dismisses after ~8 seconds, or immediately when
 * the user clicks the × affordance. Amber palette matches the
 * roadmap's dashed "unconfirmed dev estimate" accent (#f59e0b)
 * so the visual language stays consistent across surfaces.
 */
export function ViolationToast({
  delta,
  onDismiss,
}: {
  delta: ViolationDelta;
  onDismiss: () => void;
}) {
  // Store `onDismiss` in a ref so the auto-dismiss timer effect
  // can depend on nothing (fires exactly once per mount). Without
  // this, the parent's 5s polling re-render would recreate the
  // `onDismiss` closure, reset the timer, and the toast would
  // effectively never auto-close.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const t = window.setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, []);

  const { worsenedDeadlines, worsenedDependencies } = delta;
  if (worsenedDeadlines.length === 0 && worsenedDependencies.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      style={{ borderColor: "#f59e0b" }}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 space-y-1">
        {worsenedDeadlines.length > 0 ? (
          <DeadlineToastLine statuses={worsenedDeadlines} />
        ) : null}
        {worsenedDependencies.length > 0 ? (
          <DependencyToastLine statuses={worsenedDependencies} />
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss violation warning"
        className="ml-1 shrink-0 rounded px-1 leading-none text-amber-800 hover:bg-amber-100"
      >
        ×
      </button>
    </div>
  );
}

function DeadlineToastLine({ statuses }: { statuses: DeadlineStatus[] }) {
  const shown = statuses.slice(0, MAX_EXAMPLES_PER_KIND);
  const overflow = statuses.length - shown.length;
  return (
    <div>
      <span className="font-semibold">
        {"\u26A0 This change violates "}
        {statuses.length === 1 ? "a deadline" : `${statuses.length} deadlines`}
        :
      </span>{" "}
      {shown.map((s, i) => (
        <span key={s.deadline.id}>
          {i > 0 ? "; " : ""}
          {formatDeadlineExample(s)}
        </span>
      ))}
      {overflow > 0 ? <span>{`; + ${overflow} more`}</span> : null}
    </div>
  );
}

function DependencyToastLine({ statuses }: { statuses: DependencyStatus[] }) {
  const shown = statuses.slice(0, MAX_EXAMPLES_PER_KIND);
  const overflow = statuses.length - shown.length;
  return (
    <div>
      <span className="font-semibold">
        {"\u26A0 This change violates "}
        {statuses.length === 1 ? "a dependency" : `${statuses.length} dependencies`}
        :
      </span>{" "}
      {shown.map((s, i) => (
        <span key={s.dep.id}>
          {i > 0 ? "; " : ""}
          {formatDependencyExample(s)}
        </span>
      ))}
      {overflow > 0 ? <span>{`; + ${overflow} more`}</span> : null}
    </div>
  );
}

/**
 * Terse per-violation phrase for the toast. Matches the shape of
 * the spec's example: `"GA launch" was Nov 15; Development now
 * ends Dec 3`. Falls back gracefully when the deadline has no note
 * (uses the lane name as the label instead).
 */
function formatDeadlineExample(s: DeadlineStatus): string {
  const label = s.deadline.note?.trim() || s.lane?.name || "(unnamed deadline)";
  const wasDate = format(parseISO(s.deadline.deadline_date), "MMM d");
  const phaseWord = phaseLabelFor(s);
  const nowDate = s.phaseDate ? format(parseISO(s.phaseDate), "MMM d") : null;
  if (!nowDate) return `\u201C${label}\u201D was ${wasDate}`;
  return `\u201C${label}\u201D was ${wasDate}; ${phaseWord} now ends ${nowDate}`;
}

/**
 * Terse per-dependency phrase. Matches the spec's `needs
 * "Payments API upgrade" Development to finish first (still ends
 * 3 weeks after)` shape — computes the overrun in days and
 * humanizes to weeks/days as appropriate.
 */
function formatDependencyExample(s: DependencyStatus): string {
  const projectTitle = s.otherProject?.title ?? "(deleted project)";
  const otherPhase = s.otherLane?.name ?? "phase";
  const overrunDays = s.thisStart && s.otherEnd
    ? Math.max(
        0,
        Math.round((s.otherEnd.getTime() - s.thisStart.getTime()) / (24 * 60 * 60 * 1000)),
      )
    : 0;
  const overrunPhrase = humanizeDays(overrunDays);
  return `needs \u201C${projectTitle}\u201D ${otherPhase} to finish first (starts ${overrunPhrase} early)`;
}

/**
 * Best-fit `deadline_date`-side phase label so the toast reads
 * naturally. Falls back to the lane name when the phase key
 * doesn't map to one of the three human labels the view uses
 * elsewhere.
 */
function phaseLabelFor(s: DeadlineStatus): string {
  const key = s.phaseKey;
  if (key === "target_date") return "Discovery";
  if (key === "dev_start_date" || key === "dev_end_date") return "Development";
  if (key === "optimization_start_date" || key === "optimization_end_date") return "Post-Dev";
  return s.lane?.name ?? "This phase";
}

function humanizeDays(days: number): string {
  if (days <= 0) return "0 days";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"}`;
}
