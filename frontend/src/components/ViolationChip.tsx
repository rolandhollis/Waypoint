import * as Tooltip from "@radix-ui/react-tooltip";
import { format, parseISO } from "date-fns";
import type { DeadlineStatus } from "../lib/deadlines";
import type { DependencyStatus } from "../lib/dependencies";
import type { ViolationSet } from "../lib/violations";

/**
 * Compact amber chip for the EZEstimates row that surfaces the
 * project's currently-violated deadlines and/or dependencies.
 * Renders nothing when the project has no active violation — the
 * parent row's flex layout collapses the slot rather than
 * reserving placeholder space.
 *
 * Sibling of {@link ../components/EstimateProvenanceChip} — both
 * live in the same header-row slot next to the phase pickers, and
 * both keep their trigger as a plain `<span>` so keyboard focus
 * stays on the pickers.
 *
 * The label switches based on which category is failing:
 *   - deadlines only   → "⚠ Deadline miss"
 *   - dependencies only → "⚠ Dependency miss"
 *   - both              → "⚠ Deadline + dep miss"
 *
 * The hover tooltip lists every violation in full (deadlines +
 * dependencies) with the same content pattern the roadmap uses.
 * Kept as a fresh implementation because the corresponding
 * roadmap tooltips (`DeadlineAlertTooltip` / `DependencyAlertTooltip`
 * in `GanttTimeline.tsx`) are module-private and would need a
 * broader refactor to export cleanly.
 */
export function ViolationChip({ violations }: { violations: ViolationSet }) {
  const dCount = violations.deadlines.length;
  const pCount = violations.dependencies.length;
  if (dCount === 0 && pCount === 0) return null;

  const label = dCount > 0 && pCount > 0
    ? "\u26A0 Deadline + dep miss"
    : dCount > 0
      ? "\u26A0 Deadline miss"
      : "\u26A0 Dependency miss";

  return (
    <Tooltip.Root delayDuration={150}>
      <Tooltip.Trigger asChild>
        <span
          className="cursor-help whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-amber-900"
          aria-label={label}
        >
          {label}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="left"
          align="center"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-sm rounded-md border border-wp-stone bg-white px-3 py-2 text-[11px] leading-relaxed text-wp-ink shadow-lg"
        >
          <ViolationTooltipBody violations={violations} />
          <Tooltip.Arrow className="fill-white" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/**
 * Shared tooltip body used by the persistent chip and (indirectly,
 * via the same formatters) the post-mutation toast. Renders one
 * section per violation category, but only when that category has
 * at least one entry — the "deadline + dep" case shows both.
 */
export function ViolationTooltipBody({ violations }: { violations: ViolationSet }) {
  const { deadlines, dependencies } = violations;
  return (
    <div className="space-y-2">
      {deadlines.length > 0 ? (
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-amber-900">
            <span
              aria-hidden
              className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white"
            >!</span>
            {deadlines.length === 1
              ? "Deadline missed"
              : `${deadlines.length} deadlines missed`}
          </div>
          <ul className="mt-1 space-y-1">
            {deadlines.map((s) => (
              <li key={s.deadline.id}>
                <DeadlineViolationLine status={s} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {dependencies.length > 0 ? (
        <div>
          <div className="flex items-center gap-1.5 font-semibold text-amber-900">
            <span
              aria-hidden
              className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white"
            >!</span>
            {dependencies.length === 1
              ? "Dependency violated"
              : `${dependencies.length} dependencies violated`}
          </div>
          <ul className="mt-1 space-y-1">
            {dependencies.map((s) => (
              <li key={s.dep.id}>
                <DependencyViolationLine status={s} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function DeadlineViolationLine({ status }: { status: DeadlineStatus }) {
  const laneName = status.lane?.name ?? "(deleted lane)";
  const dl = format(parseISO(status.deadline.deadline_date), "MMM d, yyyy");
  const cur = status.phaseDate ? format(parseISO(status.phaseDate), "MMM d, yyyy") : null;
  return (
    <div>
      <div>
        <span className="font-medium">{laneName}</span> due{" "}
        <span className="tabular-nums">{dl}</span>
      </div>
      {cur ? (
        <div className="text-wp-slate">
          Currently landing <span className="tabular-nums">{cur}</span>
        </div>
      ) : null}
      {status.deadline.note ? (
        <div className="italic text-wp-slate">&ldquo;{status.deadline.note}&rdquo;</div>
      ) : null}
    </div>
  );
}

export function DependencyViolationLine({ status }: { status: DependencyStatus }) {
  const thisLane = status.thisLane?.name ?? "(deleted lane)";
  const otherProject = status.otherProject?.title ?? "(deleted project)";
  const otherLane = status.otherLane?.name ?? "(deleted lane)";
  return (
    <div>
      <div>
        <span className="font-medium">{thisLane}</span>
        {" starts before "}
        <span className="italic">{otherProject}</span>&rsquo;s{" "}
        <span className="font-medium">{otherLane}</span> ends
      </div>
      <div className="text-wp-slate">
        Starts{" "}
        <span className="tabular-nums">
          {status.thisStart ? format(status.thisStart, "MMM d, yyyy") : "\u2014"}
        </span>
        {" \u00b7 upstream ends "}
        <span className="tabular-nums">
          {status.otherEnd ? format(status.otherEnd, "MMM d, yyyy") : "\u2014"}
        </span>
      </div>
      {status.dep.note ? (
        <div className="italic text-wp-slate">&ldquo;{status.dep.note}&rdquo;</div>
      ) : null}
    </div>
  );
}
