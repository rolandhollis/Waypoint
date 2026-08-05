import * as Dialog from "@radix-ui/react-dialog";
import { format, parseISO } from "date-fns";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AuditEventBody,
  auditActorLabel,
  auditEventTitle,
  recentEventToRenderEntry,
} from "../lib/auditRender";
import { AUDIT_EVENT_FILTER_OPTIONS } from "../lib/auditEventFilters";
import { indexById } from "../lib/hierarchy";
import {
  useAuditEvents,
  useKpis,
  useProjects,
  useSwimLanes,
  useTeams,
  useUsers,
} from "../lib/queries";
import type { RecentAuditEvent } from "../lib/types";

function localDateTimeToIso(local: string): string | undefined {
  const trimmed = local.trim();
  if (!trimmed) return undefined;
  const d = new Date(trimmed);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function formatJson(value: unknown): string {
  if (value == null) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function AuditEventModal({
  event,
  onClose,
}: {
  event: RecentAuditEvent;
  onClose: () => void;
}) {
  const lanes = useSwimLanes();
  const teams = useTeams();
  const users = useUsers();
  const kpis = useKpis();
  const projects = useProjects();
  const projectsById = useMemo(() => indexById(projects.data ?? []), [projects.data]);

  const actor = auditActorLabel(event, users.data ?? []);
  const when = format(parseISO(event.occurred_at), "PPpp");
  const title = auditEventTitle(event);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-[8vh] z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-wp-stone bg-white shadow-xl"
        >
          <div className="border-b border-wp-stone px-4 py-3">
            <Dialog.Title className="text-base font-semibold text-wp-ink">{title}</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-wp-slate">
              {actor} · {when}
            </Dialog.Description>
          </div>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto px-4 py-4 text-sm">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-wp-slate">Project</div>
              <Link
                to={`/projects/${event.project_id}`}
                className="mt-1 font-medium text-wp-red hover:underline"
              >
                {event.project_title}
              </Link>
              {event.root_epic_id !== event.project_id ? (
                <p className="mt-1 text-xs text-wp-slate">
                  Root epic: {event.root_epic_title}
                </p>
              ) : null}
              {event.in_archive ? (
                <span className="mt-1 inline-block chip !border-slate-300 !text-slate-600">in archive lane</span>
              ) : null}
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-wp-slate">Summary</div>
              <p className="mt-1 text-wp-ink">
                <AuditEventBody
                  entry={recentEventToRenderEntry(event)}
                  lanes={lanes.data ?? []}
                  teams={teams.data ?? []}
                  users={users.data ?? []}
                  kpis={kpis.data ?? []}
                  projectsById={projectsById}
                />
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-wp-slate">Event id</div>
                <p className="mt-0.5 font-mono text-xs text-wp-ink">{event.id}</p>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-wp-slate">Kind / action</div>
                <p className="mt-0.5 text-wp-ink">
                  {event.kind} · {event.action}
                  {event.field ? ` · ${event.field}` : ""}
                </p>
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-wp-slate">From value</div>
              <pre className="mt-1 max-h-40 overflow-auto rounded border border-wp-stone bg-wp-stone/20 p-2 font-mono text-[11px] text-wp-ink">
                {formatJson(event.from_value)}
              </pre>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-wp-slate">To value</div>
              <pre className="mt-1 max-h-40 overflow-auto rounded border border-wp-stone bg-wp-stone/20 p-2 font-mono text-[11px] text-wp-ink">
                {formatJson(event.to_value)}
              </pre>
            </div>
          </div>

          <div className="flex justify-end border-t border-wp-stone px-4 py-3">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AuditTrailAdmin() {
  const users = useUsers();
  const projects = useProjects();
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");
  const [selected, setSelected] = useState<RecentAuditEvent | null>(null);

  const queryFilters = useMemo(
    () => ({
      page,
      user_id: userId || undefined,
      project_id: projectId || undefined,
      event: eventFilter || undefined,
      from: localDateTimeToIso(fromLocal),
      to: localDateTimeToIso(toLocal),
    }),
    [page, userId, projectId, eventFilter, fromLocal, toLocal],
  );

  const query = useAuditEvents(queryFilters);

  const userOptions = useMemo(
    () => (users.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [users.data],
  );

  const projectOptions = useMemo(
    () => (projects.data ?? []).slice().sort((a, b) => a.title.localeCompare(b.title)),
    [projects.data],
  );

  function clearFilters() {
    setUserId("");
    setProjectId("");
    setEventFilter("");
    setFromLocal("");
    setToLocal("");
    setPage(1);
  }

  const events = query.data?.events ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = query.data?.total_pages ?? 0;

  return (
    <div className="space-y-4">
      <section className="card-surface p-4">
        <h2 className="text-base font-semibold text-wp-ink">Audit trail</h2>
        <p className="mt-1 text-xs text-wp-slate">
          Paginated log of project changes and lane moves in this workspace. Click a row for full details.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <label className="block text-xs">
            <span className="text-wp-slate">User</span>
            <select
              className="input mt-1 w-full"
              value={userId}
              onChange={(e) => {
                setPage(1);
                setUserId(e.target.value);
              }}
            >
              <option value="">All users</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </label>

          <label className="block text-xs">
            <span className="text-wp-slate">Project</span>
            <select
              className="input mt-1 w-full"
              value={projectId}
              onChange={(e) => {
                setPage(1);
                setProjectId(e.target.value);
              }}
            >
              <option value="">All projects</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </label>

          <label className="block text-xs">
            <span className="text-wp-slate">Event</span>
            <select
              className="input mt-1 w-full"
              value={eventFilter}
              onChange={(e) => {
                setPage(1);
                setEventFilter(e.target.value);
              }}
            >
              {AUDIT_EVENT_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value || "all"} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>

          <label className="block text-xs">
            <span className="text-wp-slate">From</span>
            <input
              type="datetime-local"
              className="input mt-1 w-full"
              value={fromLocal}
              onChange={(e) => {
                setPage(1);
                setFromLocal(e.target.value);
              }}
            />
          </label>

          <label className="block text-xs">
            <span className="text-wp-slate">To</span>
            <input
              type="datetime-local"
              className="input mt-1 w-full"
              value={toLocal}
              onChange={(e) => {
                setPage(1);
                setToLocal(e.target.value);
              }}
            />
          </label>
        </div>

        <div className="mt-3">
          <button type="button" className="btn-secondary" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      </section>

      <section className="card-surface overflow-hidden">
        {query.isLoading ? (
          <p className="p-4 text-sm text-wp-slate">Loading events…</p>
        ) : query.isError ? (
          <p className="p-4 text-sm text-red-700">Failed to load audit events.</p>
        ) : events.length === 0 ? (
          <p className="p-4 text-sm text-wp-slate">No events match your filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-wp-stone/70 bg-wp-stone/15 text-left text-[11px] font-semibold uppercase tracking-wide text-wp-slate">
                  <th className="w-36 px-4 py-2.5">User</th>
                  <th className="w-40 px-3 py-2.5">Event</th>
                  <th className="px-3 py-2.5">Project</th>
                  <th className="w-44 px-4 py-2.5 text-right">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-wp-stone/50">
                {events.map((event) => {
                  const actor = auditActorLabel(event, users.data ?? []);
                  return (
                    <tr
                      key={`${event.kind}-${event.id}`}
                      className="cursor-pointer transition hover:bg-wp-stone/20"
                      onClick={() => setSelected(event)}
                    >
                      <td className="px-4 py-2.5 align-top font-medium text-wp-ink">
                        <span className="line-clamp-2" title={actor}>{actor}</span>
                      </td>
                      <td className="px-3 py-2.5 align-top text-wp-ink">
                        <span className="font-medium">{auditEventTitle(event)}</span>
                      </td>
                      <td className="px-3 py-2.5 align-top text-wp-slate">
                        <span className="line-clamp-2" title={event.project_title}>
                          {event.project_title}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 align-top text-right text-xs text-wp-slate tabular-nums whitespace-nowrap">
                        <time dateTime={event.occurred_at}>
                          {format(parseISO(event.occurred_at), "MMM d, yyyy")}
                        </time>
                        <div className="text-[11px] text-wp-slate/80">
                          {format(parseISO(event.occurred_at), "h:mm a")}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-wp-stone/70 px-4 py-3 text-xs text-wp-slate">
          <span>
            {total === 0
              ? "No events"
              : `Page ${page} of ${totalPages} · ${total} event${total === 1 ? "" : "s"}`}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary !py-1 !text-xs"
              disabled={page <= 1 || query.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-secondary !py-1 !text-xs"
              disabled={page >= totalPages || totalPages === 0 || query.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {selected ? (
        <AuditEventModal event={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}
