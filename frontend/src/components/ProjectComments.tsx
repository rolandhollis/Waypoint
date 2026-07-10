import { useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { useCurrentGroupRole, useMe, useProjectComments, useUsers } from "../lib/queries";
import type { ProjectComment, User } from "../lib/types";
import { MutationErrorBanner } from "./MutationErrorBanner";

/**
 * Threaded free-form discussion for a project. Any authenticated user
 * (including viewers) can post; only the author or an admin can edit
 * or delete their own message. Newest comment renders first.
 *
 * Kept in its own component (not inlined into ProjectDetailPanel) so
 * the panel body stays skimmable and the compose/edit local state is
 * scoped to the section that owns it.
 */
export function ProjectComments({ projectId }: { projectId: string }) {
  const me = useMe();
  // Per-group role controls edit/delete access; a user's role can
  // differ between tenants so we resolve it against the active
  // group rather than the deprecated users.role column.
  const currentUserRole = useCurrentGroupRole() ?? "viewer";
  const users = useUsers();
  const comments = useProjectComments(projectId);
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const create = useMutation({
    mutationFn: (body: string) =>
      api<ProjectComment>(`/projects/${projectId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: ["projectComments", projectId] });
    },
  });

  const canSubmit = draft.trim().length > 0 && !create.isPending;

  return (
    <section>
      <h3 className="text-sm font-semibold text-wp-ink">Comments</h3>

      <div className="mt-2 space-y-2">
        <textarea
          className="input min-h-[64px] w-full resize-y text-sm"
          placeholder="Write a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl-Enter submits, matching most chat inputs.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
              e.preventDefault();
              create.mutate(draft);
            }
          }}
        />
        <MutationErrorBanner mutation={create} />
        <div className="flex items-center justify-between text-xs text-wp-slate">
          <span>
            {create.isPending ? "Posting…" : <>Cmd/Ctrl-Enter to post</>}
          </span>
          <button
            type="button"
            className="btn-primary !py-1 text-xs"
            disabled={!canSubmit}
            onClick={() => create.mutate(draft)}
          >
            Post comment
          </button>
        </div>
      </div>

      {comments.data && comments.data.length ? (
        <ol className="mt-4 space-y-3">
          {comments.data.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              projectId={projectId}
              users={users.data ?? []}
              currentUserId={me.data?.id ?? null}
              currentUserRole={currentUserRole}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-xs text-wp-slate">No comments yet.</p>
      )}
    </section>
  );
}

function CommentRow({
  comment,
  projectId,
  users,
  currentUserId,
  currentUserRole,
}: {
  comment: ProjectComment;
  projectId: string;
  users: User[];
  currentUserId: string | null;
  currentUserRole: "admin" | "owner" | "viewer";
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  const author = users.find((u) => u.id === comment.author_user_id);
  const isMine = currentUserId != null && comment.author_user_id === currentUserId;
  const canManage = isMine || currentUserRole === "admin";
  const wasEdited =
    new Date(comment.updated_at).getTime() - new Date(comment.created_at).getTime() > 1000;

  const patch = useMutation({
    mutationFn: (body: string) =>
      api<ProjectComment>(`/projects/${projectId}/comments/${comment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["projectComments", projectId] });
    },
  });

  const del = useMutation({
    mutationFn: () =>
      api<void>(`/projects/${projectId}/comments/${comment.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectComments", projectId] });
    },
  });

  return (
    <li className="rounded-md border border-wp-stone bg-white px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-wp-slate">
        {author ? (
          <span
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white"
            style={{ background: author.color }}
            title={author.name}
          >
            {initials(author.name)}
          </span>
        ) : (
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-wp-stone text-[10px] font-semibold text-wp-slate">
            ?
          </span>
        )}
        <span className="font-medium text-wp-ink">{author?.name ?? "unknown"}</span>
        <span>·</span>
        <span title={comment.created_at}>
          {format(new Date(comment.created_at), "yyyy-MM-dd HH:mm")}
        </span>
        {wasEdited ? <span className="text-wp-slate/70">(edited)</span> : null}
        {canManage && !editing ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
              aria-label="Edit comment"
              title="Edit"
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className="rounded p-1 text-wp-slate hover:bg-red-50 hover:text-wp-red disabled:opacity-50"
              onClick={() => {
                if (confirm("Delete this comment?")) del.mutate();
              }}
              disabled={del.isPending}
              aria-label="Delete comment"
              title="Delete"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            className="input min-h-[64px] w-full resize-y text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <MutationErrorBanner mutation={patch} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-primary !py-1 text-xs"
              disabled={draft.trim().length === 0 || patch.isPending}
              onClick={() => patch.mutate(draft.trim())}
            >
              {patch.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn-ghost !py-1 text-xs"
              onClick={() => setEditing(false)}
            >
              <X size={12} className="mr-0.5 inline" /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-wp-ink">{comment.body}</p>
      )}

      <MutationErrorBanner mutation={del} className="mt-2" />
    </li>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
