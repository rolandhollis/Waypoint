import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { format } from "date-fns";
import { ChevronLeft, ChevronRight, Octagon, Trash2, X } from "lucide-react";
import { AuditEventBody, auditActorLabel } from "../lib/auditRender";
import { cn } from "../lib/cn";
import {
  useDesignItemHistory,
  useTeams,
  useUsers,
  type MentionableUser,
} from "../lib/queries";
import type { DesignItem, DesignTicketStatus, DesignTimelineEntry } from "../lib/types";
import { useAppDialog } from "./AppDialogProvider";

const TICKET_STATUS_META: Record<
  DesignTicketStatus,
  { label: string; className: string }
> = {
  not: {
    label: "Not started",
    className: "bg-wp-stone/60 text-wp-slate border-wp-stone",
  },
  on: {
    label: "On-track",
    className: "bg-sky-50 text-sky-800 border-sky-200",
  },
  risk: {
    label: "At Risk",
    className: "bg-red-50 text-red-800 border-red-200",
  },
  review: {
    label: "In Review",
    className: "bg-violet-50 text-violet-800 border-violet-200",
  },
  indev: {
    label: "In Development",
    className: "bg-teal-50 text-teal-800 border-teal-200",
  },
  done: {
    label: "Completed",
    className: "bg-emerald-50 text-emerald-800 border-emerald-200",
  },
};

export type DesignItemPatch = Partial<
  Pick<
    DesignItem,
    | "name"
    | "description"
    | "team_id"
    | "assigned_to"
    | "ticket_status"
    | "jira_key"
    | "links"
    | "due_date"
    | "is_blocked"
    | "blocked_reason"
  >
>;

/**
 * Right-side detail drawer for a Design Tickets board card — same
 * Radix shell pattern as `ProjectDetailPanel`, with design-ticket fields.
 */
export function DesignDetailPanel({
  item,
  onClose,
  onOpenTicket,
  siblingIds,
  canWrite,
  canDelete,
  patchPending,
  onPatch,
  onDelete,
  userOptions,
  teamOptions,
}: {
  item: DesignItem;
  onClose: () => void;
  onOpenTicket?: (nextId: string) => void;
  siblingIds?: string[];
  canWrite: boolean;
  canDelete: boolean;
  patchPending: boolean;
  onPatch: (id: string, body: DesignItemPatch) => void;
  onDelete: () => void;
  userOptions: MentionableUser[];
  teamOptions: { id: string; name: string }[];
}) {
  const history = useDesignItemHistory(item.id);
  const users = useUsers();
  const teams = useTeams();
  const { confirm, prompt } = useAppDialog();

  const [editName, setEditName] = useState(item.name);
  const [editDesc, setEditDesc] = useState(item.description);
  const [editStatus, setEditStatus] = useState(item.ticket_status);
  const [editAssignee, setEditAssignee] = useState(item.assigned_to ?? "");
  const [editTeam, setEditTeam] = useState(item.team_id ?? "");
  const [editJira, setEditJira] = useState(item.jira_key ?? "");
  const [editDue, setEditDue] = useState(item.due_date ?? "");

  useEffect(() => {
    setEditName(item.name);
    setEditDesc(item.description);
    setEditStatus(item.ticket_status);
    setEditAssignee(item.assigned_to ?? "");
    setEditTeam(item.team_id ?? "");
    setEditJira(item.jira_key ?? "");
    setEditDue(item.due_date ?? "");
  }, [
    item.id,
    item.name,
    item.description,
    item.ticket_status,
    item.assigned_to,
    item.team_id,
    item.jira_key,
    item.due_date,
  ]);

  async function handleBlockedClick() {
    if (item.is_blocked) {
      const ok = await confirm({
        title: "Clear blocked status?",
        description: item.blocked_reason
          ? `This will remove the blocked flag and reason:\n“${item.blocked_reason}”`
          : "This will remove the blocked flag.",
        confirmLabel: "Clear blocked",
        cancelLabel: "Keep blocked",
      });
      if (!ok) return;
      onPatch(item.id, { is_blocked: false, blocked_reason: null });
      return;
    }
    const reason = await prompt({
      title: "Mark as blocked",
      description: "Why is this ticket blocked? The reason shows when someone hovers the stop sign on the board.",
      placeholder: "e.g. Waiting on copy / brand assets",
      defaultValue: item.blocked_reason ?? "",
      confirmLabel: "Mark blocked",
    });
    if (reason === null) return;
    const trimmed = reason.trim();
    if (!trimmed) return;
    onPatch(item.id, { is_blocked: true, blocked_reason: trimmed });
  }

  const statusMeta = TICKET_STATUS_META[item.ticket_status] ?? TICKET_STATUS_META.not;
  const siblingNav = (() => {
    if (!siblingIds || !onOpenTicket) return null;
    const idx = siblingIds.indexOf(item.id);
    if (idx < 0) return null;
    return {
      prev: idx > 0 ? siblingIds[idx - 1]! : null,
      next: idx < siblingIds.length - 1 ? siblingIds[idx + 1]! : null,
      pos: idx + 1,
      total: siblingIds.length,
    };
  })();

  useEffect(() => {
    if (!siblingNav || !onOpenTicket) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
        return;
      }
      if (e.key === "ArrowLeft" && siblingNav!.prev) {
        e.preventDefault();
        onOpenTicket!(siblingNav!.prev);
      } else if (e.key === "ArrowRight" && siblingNav!.next) {
        e.preventDefault();
        onOpenTicket!(siblingNav!.next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [siblingNav, onOpenTicket]);

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-xl outline-none">
          <header className="flex items-start gap-3 border-b border-wp-stone px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {canWrite ? (
                  <button
                    type="button"
                    aria-label={item.is_blocked ? "Clear blocked status" : "Mark as blocked"}
                    aria-pressed={item.is_blocked}
                    title={
                      item.is_blocked
                        ? item.blocked_reason
                          ? `Blocked: ${item.blocked_reason}`
                          : "Blocked — click to clear"
                        : "Mark as blocked"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleBlockedClick();
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    disabled={patchPending}
                    className={
                      "inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-0.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-red/40 " +
                      (item.is_blocked
                        ? "bg-red-100 text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-200"
                        : "text-wp-slate/40 hover:scale-110 hover:bg-wp-stone/40 hover:text-wp-slate")
                    }
                  >
                    <span className="relative inline-flex size-[18px] items-center justify-center">
                      <Octagon
                        size={18}
                        className={item.is_blocked ? "fill-red-600 text-red-700" : ""}
                      />
                      <X
                        size={10}
                        strokeWidth={3}
                        className={
                          "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 " +
                          (item.is_blocked ? "text-white" : "text-current")
                        }
                        aria-hidden
                      />
                    </span>
                  </button>
                ) : item.is_blocked ? (
                  <span
                    className="inline-flex shrink-0 items-center justify-center rounded bg-red-100 p-0.5 text-red-700 ring-1 ring-inset ring-red-300"
                    title={item.blocked_reason ? `Blocked: ${item.blocked_reason}` : "Blocked"}
                    aria-label={item.blocked_reason ? `Blocked: ${item.blocked_reason}` : "Blocked"}
                  >
                    <span className="relative inline-flex size-[18px] items-center justify-center">
                      <Octagon size={18} className="fill-red-600 text-red-700" />
                      <X
                        size={10}
                        strokeWidth={3}
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white"
                        aria-hidden
                      />
                    </span>
                  </span>
                ) : null}
                <Dialog.Title className="min-w-0 flex-1 truncate text-base font-semibold text-wp-ink">
                  {item.name}
                </Dialog.Title>
              </div>
              <Dialog.Description className="mt-1 space-y-1 text-xs text-wp-slate">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                      statusMeta.className,
                    )}
                  >
                    {statusMeta.label}
                  </span>
                  {item.assignee_name ? <span>{item.assignee_name}</span> : <span>Unassigned</span>}
                  {item.team_name ? <span>· {item.team_name}</span> : null}
                </div>
                <div>
                  Created by{" "}
                  <span className="font-medium text-wp-ink">
                    {item.creator_name || "Unknown"}
                  </span>
                  {item.created_at ? (
                    <>
                      {" "}
                      on {format(new Date(item.created_at), "MMM d, yyyy")}
                    </>
                  ) : null}
                </div>
              </Dialog.Description>
            </div>
            {siblingNav ? (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  className="btn-ghost !p-1.5 disabled:opacity-30"
                  disabled={!siblingNav.prev}
                  onClick={() => siblingNav.prev && onOpenTicket?.(siblingNav.prev)}
                  aria-label="Previous ticket"
                >
                  <ChevronLeft size={18} />
                </button>
                <span className="min-w-[3rem] text-center text-[11px] tabular-nums text-wp-slate">
                  {siblingNav.pos}/{siblingNav.total}
                </span>
                <button
                  type="button"
                  className="btn-ghost !p-1.5 disabled:opacity-30"
                  disabled={!siblingNav.next}
                  onClick={() => siblingNav.next && onOpenTicket?.(siblingNav.next)}
                  aria-label="Next ticket"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            ) : null}
            <button
              type="button"
              className="btn-ghost !p-1.5 text-wp-slate hover:text-wp-ink"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {canWrite ? (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  onPatch(item.id, {
                    name: editName.trim(),
                    description: editDesc.trim(),
                    ticket_status: editStatus,
                    assigned_to: editAssignee || null,
                    team_id: editTeam || null,
                    jira_key: editJira.trim() || null,
                    due_date: editDue.trim() || null,
                  });
                }}
              >
                <label className="block">
                  <span className="text-xs font-medium text-wp-slate">Name</span>
                  <input
                    className="input mt-1 w-full"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-wp-slate">Description</span>
                  <textarea
                    className="input mt-1 min-h-[120px] w-full"
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    rows={5}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-medium text-wp-slate">Status</span>
                    <select
                      className="input mt-1 w-full"
                      value={editStatus}
                      onChange={(e) => setEditStatus(e.target.value as DesignTicketStatus)}
                    >
                      {(Object.keys(TICKET_STATUS_META) as DesignTicketStatus[]).map((k) => (
                        <option key={k} value={k}>
                          {TICKET_STATUS_META[k].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-wp-slate">Assignee</span>
                    <select
                      className="input mt-1 w-full"
                      value={editAssignee}
                      onChange={(e) => setEditAssignee(e.target.value)}
                    >
                      <option value="">Unassigned</option>
                      {userOptions.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-wp-slate">Product area</span>
                    <select
                      className="input mt-1 w-full"
                      value={editTeam}
                      onChange={(e) => setEditTeam(e.target.value)}
                    >
                      <option value="">—</option>
                      {teamOptions.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-wp-slate">Jira key</span>
                    <input
                      className="input mt-1 w-full"
                      value={editJira}
                      onChange={(e) => setEditJira(e.target.value)}
                      placeholder="FAL-1105"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-wp-slate">Due date</span>
                    <input
                      type="date"
                      className="input mt-1 w-full"
                      value={editDue}
                      onChange={(e) => setEditDue(e.target.value)}
                    />
                  </label>
                </div>

                {(item.links ?? []).length > 0 ? (
                  <div>
                    <div className="text-xs font-medium text-wp-slate">Links</div>
                    <ul className="mt-1 space-y-1">
                      {item.links.map((l) => (
                        <li key={`${l.label}-${l.url}`}>
                          <a
                            href={l.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-medium text-wp-red hover:underline"
                          >
                            {l.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="flex items-center justify-between gap-2 border-t border-wp-stone pt-4">
                  <button type="submit" className="btn-primary" disabled={patchPending || !editName.trim()}>
                    {patchPending ? "Saving…" : "Save"}
                  </button>
                  {canDelete ? (
                    <button
                      type="button"
                      className="btn-secondary inline-flex items-center gap-1.5 text-wp-slate hover:text-wp-red"
                      onClick={onDelete}
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  ) : null}
                </div>
              </form>
            ) : (
              <div className="space-y-4 text-sm">
                {item.description.trim() ? (
                  <p className="whitespace-pre-wrap text-wp-ink">{item.description.trim()}</p>
                ) : (
                  <p className="italic text-wp-slate">No description.</p>
                )}
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="font-medium text-wp-slate">Status</dt>
                    <dd className="mt-0.5 text-wp-ink">{statusMeta.label}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-wp-slate">Assignee</dt>
                    <dd className="mt-0.5 text-wp-ink">{item.assignee_name ?? "Unassigned"}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-wp-slate">Product area</dt>
                    <dd className="mt-0.5 text-wp-ink">{item.team_name ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-wp-slate">Jira</dt>
                    <dd className="mt-0.5 text-wp-ink">{item.jira_key ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-wp-slate">Due date</dt>
                    <dd className="mt-0.5 text-wp-ink">
                      {item.due_date
                        ? format(new Date(`${item.due_date}T00:00:00`), "MMM d, yyyy")
                        : "—"}
                    </dd>
                  </div>
                  {item.is_blocked ? (
                    <div className="col-span-2">
                      <dt className="font-medium text-wp-slate">Blocked</dt>
                      <dd className="mt-0.5 text-wp-ink">
                        {item.blocked_reason?.trim() || "Yes"}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {(item.links ?? []).length > 0 ? (
                  <ul className="space-y-1">
                    {item.links.map((l) => (
                      <li key={`${l.label}-${l.url}`}>
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-wp-red hover:underline"
                        >
                          {l.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {canDelete ? (
                  <div className="border-t border-wp-stone pt-4">
                    <button
                      type="button"
                      className="btn-secondary inline-flex items-center gap-1.5 text-wp-slate hover:text-wp-red"
                      onClick={onDelete}
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            )}

            <section className="mt-8 border-t border-wp-stone pt-4">
              <h3 className="text-sm font-semibold text-wp-ink">Audit trail</h3>
              {history.isLoading ? (
                <p className="mt-1.5 text-xs text-wp-slate">Loading activity…</p>
              ) : history.data && history.data.length ? (
                <ol className="mt-2 space-y-1 text-xs text-wp-slate">
                  {history.data.slice().reverse().map((h) => (
                    <DesignHistoryRow
                      key={h.id}
                      entry={h}
                      users={users.data ?? []}
                      teams={teams.data ?? []}
                    />
                  ))}
                </ol>
              ) : (
                <p className="mt-1.5 text-xs text-wp-slate">No activity yet.</p>
              )}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DesignHistoryRow({
  entry,
  users,
  teams,
}: {
  entry: DesignTimelineEntry;
  users: { id: string; name: string }[];
  teams: { id: string; name: string }[];
}) {
  const who = auditActorLabel(entry, users);
  return (
    <li className="leading-relaxed">
      <span className="text-wp-slate/80">
        {format(new Date(entry.timestamp), "yyyy-MM-dd HH:mm")}
      </span>
      {" · "}
      <span>{who}</span>{" "}
      <AuditEventBody
        entry={{
          kind: entry.kind,
          field: entry.field,
          from_value: entry.from_value,
          to_value: entry.to_value,
        }}
        lanes={[]}
        teams={teams}
        users={users}
        kpis={[]}
      />
    </li>
  );
}
