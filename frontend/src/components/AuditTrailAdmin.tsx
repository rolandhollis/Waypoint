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
import { indexById } from "../lib/hierarchy";
import {
  useAuditEvents,
  useKpis,
  useProjects,
  useSwimLanes,
  useTeams,
  useUsers,
} from "../lib/queries";
import type { AuditAction, RecentAuditEvent } from "../lib/types";

const ACTION_OPTIONS: { value: "" | AuditAction; label: string }[] = [
  { value: "", label: "All event types" },
  { value: "create", label: "Created" },
  { value: "edit", label: "Edited" },
  { value: "move", label: "Lane move" },
  { value: "archive", label: "Archived" },
  { value: "restore", label: "Restored" },
];

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
  const [page, setPage] = useState(1);
  const [draftUserId, setDraftUserId] = useState("");
  const [draftAction, setDraftAction] = useState<"" | AuditAction>("");
  const [draftFromLocal, setDraftFromLocal] = useState("");
  const [draftToLocal, setDraftToLocal] = useState("");
  const [applied, setApplied] = useState<{
    user_id?: string;
    action?: AuditAction;
    from?: string;
    to?: string;
  }>({});
  const [selected, setSelected] = useState<RecentAuditEvent | null>(null);

  const query = useAuditEvents({
    page,
    ...applied,
  });

  const userOptions = useMemo(
    () => (users.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [users.data],
  );

  function applyFilters() {
    setPage(1);
    setApplied({
      user_id: draftUserId || undefined,
      action: draftAction || undefined,
      from: localDateTimeToIso(draftFromLocal),
      to: localDateTimeToIso(draftToLocal),
    });
  }

  function clearFilters() {
    setDraftUserId("");
    setDraftAction("");
    setDraftFromLocal("");
    setDraftToLocal("");
    setPage(1);
    setApplied({});
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

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-xs">
            <span className="text-wp-slate">User</span>
            <select
              className="input mt-1 w-full"
              value={draftUserId}
              onChange={(e) => setDraftUserId(e.target.value)}
            >
              <option value="">All users</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </label>

          <label className="block text-xs">
            <span className="text-wp-slate">Event type</span>
            <select
              className="input mt-1 w-full"
              value={draftAction}
              onChange={(e) => setDraftAction(e.target.value as "" | AuditAction)}
            >
              {ACTION_OPTIONS.map((opt) => (
                <option key={opt.value || "all"} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>

          <label className="block text-xs">
            <span className="text-wp-slate">From</span>
            <input
              type="datetime-local"
              className="input mt-1 w-full"
              value={draftFromLocal}
              onChange={(e) => setDraftFromLocal(e.target.value)}
            />
          </label>

          <label className="block text-xs">
            <span className="text-wp-slate">To</span>
            <input
              type="datetime-local"
              className="input mt-1 w-full"
              value={draftToLocal}
              onChange={(e) => setDraftToLocal(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={applyFilters}>
            Apply filters
          </button>
          <button type="button" className="btn-secondary" onClick={clearFilters}>
            Clear
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
          <ul className="divide-y divide-wp-stone/70">
            {events.map((event) => (
              <li key={`${event.kind}-${event.id}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-wp-stone/20"
                  onClick={() => setSelected(event)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-wp-ink">{auditEventTitle(event)}</div>
                    <div className="mt-0.5 text-xs text-wp-slate">
                      {auditActorLabel(event, users.data ?? [])}
                      <span className="mx-1">·</span>
                      {event.project_title}
                    </div>
                  </div>
                  <time
                    className="shrink-0 text-xs text-wp-slate tabular-nums"
                    dateTime={event.occurred_at}
                  >
                    {format(parseISO(event.occurred_at), "MMM d, yyyy h:mm a")}
                  </time>
                </button>
              </li>
            ))}
          </ul>
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
