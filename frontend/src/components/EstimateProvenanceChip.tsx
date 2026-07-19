import * as Tooltip from "@radix-ui/react-tooltip";
import { format } from "date-fns";
import type { EstimateSource, Project, User } from "../lib/types";

/**
 * Compact "last touched" chip for an EZEstimates row. Displays a
 * one-line summary of the MOST RECENT of the three per-phase
 * provenance stamps (Discovery / Development / Post-Dev), plus a
 * hover tooltip that breaks down each phase individually.
 *
 * Data source: the nine `<phase>_updated_*` columns added by
 * migration 032. NULL across the board = "no update recorded yet"
 * → renders as `null` from this component so the parent can
 * layout-collapse the slot rather than showing an em-dash placeholder.
 *
 * Label rules (kept in sync with the spec in the calling issue):
 *
 *   `Updated <M/D/YY> · <source label>`
 *
 * Source labels:
 *   * `'user'`    → first name of the acting user (looked up in the
 *                   passed `usersById` map; falls back to
 *                   `"unknown user"` when the user was deleted).
 *   * `'claude'`  → literal `"Claude"`.
 *   * `'csv'`     → literal `"CSV import"`.
 *   * `'cascade'` → literal `"Cascade"`.
 *
 * The tooltip shows one row per phase with either
 * `updated <date> by <source label>` or `—` when that phase has
 * never been touched. The acting user's first name is appended
 * inside a `by <first name>` tail whenever the source recorded a
 * user id — that includes `cascade`, so a curious PM can still see
 * whose upstream pick propagated forward.
 */
export function EstimateProvenanceChip({
  project,
  usersById,
}: {
  project: Pick<
    Project,
    | "discovery_updated_at"
    | "discovery_updated_by_user_id"
    | "discovery_updated_source"
    | "development_updated_at"
    | "development_updated_by_user_id"
    | "development_updated_source"
    | "post_dev_updated_at"
    | "post_dev_updated_by_user_id"
    | "post_dev_updated_source"
  >;
  usersById: Map<string, User>;
}) {
  const phases = getPhaseStamps(project);
  const latest = pickLatestStamp(phases);
  if (!latest) return null;

  const headlineLabel = sourceHeadline(latest.source, latest.userId, usersById);
  const headlineDate = format(new Date(latest.at), "M/d/yy");
  const tooltipLines = phases.map((p) => renderTooltipLine(p, usersById));

  return (
    <Tooltip.Root delayDuration={150}>
      <Tooltip.Trigger asChild>
        <span
          // Rendered as a non-interactive span (with cursor-help) so
          // it doesn't steal keyboard focus from the phase pickers
          // sitting next to it. Radix still binds hover / focus
          // events onto the span so keyboard users tabbing THROUGH
          // the row see the tooltip via the pickers' focus.
          className="whitespace-nowrap text-[10px] leading-tight text-wp-slate/80 hover:text-wp-slate cursor-help"
          aria-label={`Last updated ${headlineDate} · ${headlineLabel}`}
        >
          Updated {headlineDate} · {headlineLabel}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="left"
          align="center"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-xs rounded-md border border-wp-stone bg-white px-3 py-2 text-[11px] leading-relaxed text-wp-ink shadow-lg"
        >
          <div className="mb-1 font-semibold text-wp-ink">Estimate history</div>
          <table className="w-full">
            <tbody>
              {tooltipLines.map((row) => (
                <tr key={row.label}>
                  <td className="pr-2 align-top text-wp-slate">{row.label}</td>
                  <td className="align-top">{row.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Tooltip.Arrow className="fill-white" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

type PhaseStamp = {
  key: "discovery" | "development" | "post_dev";
  label: string;
  at: string | null;
  userId: string | null;
  source: EstimateSource | null;
};

function getPhaseStamps(
  p: Parameters<typeof EstimateProvenanceChip>[0]["project"],
): PhaseStamp[] {
  return [
    {
      key: "discovery",
      label: "Discovery",
      at: p.discovery_updated_at,
      userId: p.discovery_updated_by_user_id,
      source: p.discovery_updated_source,
    },
    {
      key: "development",
      label: "Development",
      at: p.development_updated_at,
      userId: p.development_updated_by_user_id,
      source: p.development_updated_source,
    },
    {
      key: "post_dev",
      label: "Post-Dev",
      at: p.post_dev_updated_at,
      userId: p.post_dev_updated_by_user_id,
      source: p.post_dev_updated_source,
    },
  ];
}

type LatestStamp = { at: string; userId: string | null; source: EstimateSource };

function pickLatestStamp(phases: PhaseStamp[]): LatestStamp | null {
  let best: LatestStamp | null = null;
  for (const p of phases) {
    if (!p.at || !p.source) continue;
    if (best == null || p.at > best.at) {
      best = { at: p.at, userId: p.userId, source: p.source };
    }
  }
  return best;
}

/** Short "Roland" / "Claude" / "CSV import" / "Cascade" label. */
function sourceHeadline(
  source: EstimateSource,
  userId: string | null,
  usersById: Map<string, User>,
): string {
  switch (source) {
    case "user":
      return firstNameFor(userId, usersById);
    case "claude":
      return "Claude";
    case "csv":
      return "CSV import";
    case "cascade":
      return "Cascade";
    default: {
      // Defensive: an unknown source shouldn't be persisted (the DB
      // CHECK blocks it), but if a future migration adds a value the
      // client hasn't been redeployed with, render the raw string
      // instead of blowing up the row.
      const exhaustive: never = source;
      return String(exhaustive);
    }
  }
}

function firstNameFor(
  userId: string | null,
  usersById: Map<string, User>,
): string {
  if (!userId) return "unknown user";
  const u = usersById.get(userId);
  if (!u) return "unknown user";
  const first = u.name.trim().split(/\s+/)[0];
  return first || u.name || "unknown user";
}

/** One row of the hover tooltip's three-row breakdown table. */
function renderTooltipLine(
  phase: PhaseStamp,
  usersById: Map<string, User>,
): { label: string; text: string } {
  if (!phase.at || !phase.source) {
    return { label: phase.label, text: "—" };
  }
  const dateStr = format(new Date(phase.at), "M/d/yy");
  const srcLabel = sourceLabelForTooltip(phase.source);
  const actor = phase.userId ? firstNameFor(phase.userId, usersById) : null;
  // Cascade / csv / claude sources still have an actor (the user
  // who triggered the ripple / import / prompt), so appending "by X"
  // is useful for all four. The 'user' source uses the actor's
  // first name AS the source label already, so we skip the "by"
  // tail to avoid "user Roland by Roland" style duplication.
  if (phase.source === "user") {
    return {
      label: phase.label,
      text: `updated ${dateStr} by ${actor ?? "unknown user"}`,
    };
  }
  const tail = actor ? ` by ${actor}` : "";
  return {
    label: phase.label,
    text: `updated ${dateStr} via ${srcLabel}${tail}`,
  };
}

function sourceLabelForTooltip(source: EstimateSource): string {
  switch (source) {
    case "user":
      return "user";
    case "claude":
      return "Claude";
    case "csv":
      return "CSV import";
    case "cascade":
      return "cascade";
    default: {
      const exhaustive: never = source;
      return String(exhaustive);
    }
  }
}
