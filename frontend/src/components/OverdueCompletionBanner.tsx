import { format, parseISO } from "date-fns";
import { AlertTriangle } from "lucide-react";
import { Link } from "react-router-dom";
import { useOverdueCompletion } from "../lib/queries";

/**
 * Live banner for projects the current user owns whose planned
 * completion date (optimization_end_date) has passed and that are
 * not yet Complete/Archive. Independent of the email job — shows
 * whenever the predicate matches.
 */
export function OverdueCompletionBanner() {
  const overdue = useOverdueCompletion();
  const projects = overdue.data?.projects ?? [];
  if (projects.length === 0) return null;

  const count = projects.length;
  const label = count === 1 ? "1 project" : `${count} projects`;

  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-900"
      role="status"
    >
      <AlertTriangle size={16} className="shrink-0" />
      <div className="font-medium">
        Completion date passed — {label} need Complete or a new date
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {projects.slice(0, 6).map((p) => (
          <li key={p.id}>
            <Link
              to={`/projects/${p.id}`}
              className="rounded-full border border-current/40 bg-white/70 px-2 py-0.5 text-xs font-medium underline-offset-2 hover:underline"
              title={`Completion ${format(parseISO(p.optimization_end_date), "MMM d, yyyy")}`}
            >
              {p.title}
            </Link>
          </li>
        ))}
        {count > 6 ? <li className="text-xs">+{count - 6} more</li> : null}
      </ul>
    </div>
  );
}
