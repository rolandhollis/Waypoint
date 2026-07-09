import { format, parseISO } from "date-fns";
import { AlertTriangle } from "lucide-react";
import type { OverloadInterval } from "../lib/capacity";
import type { Team, User } from "../lib/types";

/**
 * Non-blocking capacity warning shown inline in the create / edit
 * forms when the draft state would push an owner or a team over
 * their configured cap.
 *
 * The banner never prevents saving — the product spec is explicit
 * that the user should be able to ignore the warning ("which they
 * can choose to ignore"). The Save button stays enabled; this is
 * purely informational.
 */
export function CapacityWarning({
  intervals,
  users,
  teams,
  className,
}: {
  intervals: OverloadInterval[];
  users: User[];
  teams: Team[];
  className?: string;
}) {
  if (intervals.length === 0) return null;

  const userById = new Map(users.map((u) => [u.id, u]));
  const teamById = new Map(teams.map((t) => [t.id, t]));

  return (
    <div
      className={
        "flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 " +
        (className ?? "")
      }
      role="status"
      aria-live="polite"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
      <div className="min-w-0">
        <div className="font-semibold">
          Heads-up: this puts {intervals.length === 1 ? "someone" : `${intervals.length} owners/teams`} over their capacity.
        </div>
        <ul className="mt-1 space-y-0.5">
          {intervals.map((iv, i) => {
            const name = iv.kind === "owner"
              ? userById.get(iv.entityId)?.name ?? "unknown user"
              : teamById.get(iv.entityId)?.name ?? "unknown team";
            const kindLabel = iv.kind === "owner" ? "owner" : "team";
            return (
              <li key={`${iv.kind}-${iv.entityId}-${iv.from}-${i}`}>
                <span className="font-medium">{name}</span>{" "}
                <span className="text-amber-800/80">({kindLabel})</span>{" "}
                — {formatRange(iv.from, iv.to)}: {iv.peak} active vs. cap of {iv.cap}
              </li>
            );
          })}
        </ul>
        <div className="mt-1 text-amber-800/70">
          You can save anyway — this is just a heads-up.
        </div>
      </div>
    </div>
  );
}

function formatRange(fromIso: string, toIso: string): string {
  const a = parseISO(fromIso);
  const b = parseISO(toIso);
  if (fromIso === toIso) return format(a, "MMM d, yyyy");
  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();
  if (sameMonth) {
    return `${format(a, "MMM d")}–${format(b, "d, yyyy")}`;
  }
  if (sameYear) {
    return `${format(a, "MMM d")} – ${format(b, "MMM d, yyyy")}`;
  }
  return `${format(a, "MMM d, yyyy")} – ${format(b, "MMM d, yyyy")}`;
}
