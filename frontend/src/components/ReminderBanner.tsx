import { format } from "date-fns";
import { AlertTriangle, Bell } from "lucide-react";
import { Link } from "react-router-dom";
import { usePendingStatus, useProjects } from "../lib/queries";

export function ReminderBanner() {
  const pending = usePendingStatus();
  const projects = useProjects();
  const data = pending.data;
  if (!data || data.pending.length === 0) return null;

  const overdue = new Date(data.due_at) < new Date();
  const byId = new Map((projects.data ?? []).map((p) => [p.id, p]));

  return (
    <div
      className={`flex flex-wrap items-center gap-3 border-b px-5 py-2 text-sm ${
        overdue
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-amber-200 bg-amber-50 text-amber-900"
      }`}
      role="status"
    >
      {overdue ? <AlertTriangle size={16} /> : <Bell size={16} />}
      <div className="font-medium">
        {overdue ? "Weekly status is overdue" : "Weekly status due"} — {data.pending.length} project(s) still need an update
        <span className="ml-1 font-normal text-inherit/70">
          (due {format(new Date(data.due_at), "EEE MMM d, h:mm a")})
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {data.pending.slice(0, 6).map((p) => {
          const proj = byId.get(p.project_id);
          return (
            <li key={p.project_id}>
              <Link
                to={`/board?project=${p.project_id}`}
                className="rounded-full border border-current/40 bg-white/70 px-2 py-0.5 text-xs font-medium underline-offset-2 hover:underline"
              >
                {proj?.title ?? p.project_id.slice(0, 8)}
              </Link>
            </li>
          );
        })}
        {data.pending.length > 6 ? <li className="text-xs">+{data.pending.length - 6} more</li> : null}
      </ul>
    </div>
  );
}
