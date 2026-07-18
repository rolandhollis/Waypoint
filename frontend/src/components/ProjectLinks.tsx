import { useState } from "react";
import { Link2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCanWrite, useProjectLinks } from "../lib/queries";
import type { Project, ProjectLink } from "../lib/types";
import { DEFAULT_NEW_LABEL, LinkLabelPicker } from "./LinkLabelPicker";

/**
 * Links section of the project detail panel.
 *
 * Modeled on ProjectDeadlines / ProjectDependencies for structure
 * and spacing so it fits alongside them visually. Each link is a
 * (label, url) pair; label is denormalized per-link — see
 * LinkLabelPicker for the suggestion sourcing and migration 027
 * for the schema.
 *
 * Viewer role: read + click-through only. Owner/admin: add, edit,
 * delete. One row can be in "edit" mode at a time — same pattern
 * as deadlines/dependencies above.
 */
export function ProjectLinks({ project }: { project: Project }) {
  const canWrite = useCanWrite();
  const links = useProjectLinks(project.id);
  const qc = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const del = useMutation({
    mutationFn: (linkId: string) =>
      api(`/links/${linkId}`, { method: "DELETE" }),
    onSuccess: () => {
      // The links list is its own query key so we invalidate that
      // one first. History is invalidated so the audit trail picks
      // up the new "removed link" row; label-suggestions is
      // invalidated because deleting the last carrier of a label
      // should drop it from the suggestion list.
      qc.invalidateQueries({ queryKey: ["projectLinks", project.id] });
      qc.invalidateQueries({ queryKey: ["projectHistory", project.id] });
      qc.invalidateQueries({ queryKey: ["linkLabelSuggestions"] });
      setEditingId(null);
    },
  });

  const rows = links.data ?? [];

  return (
    <section className="mt-6">
      <div className="flex items-center gap-2">
        <Link2 size={14} className="text-wp-slate" aria-hidden />
        <h3 className="text-sm font-semibold text-wp-ink">Links</h3>
        <span className="text-xs text-wp-slate">
          Attach related URLs — Jira, Confluence, Figma, etc.
        </span>
      </div>

      {rows.length === 0 && !adding ? (
        <p className="mt-2 text-xs text-wp-slate">No links attached.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {rows.map((link) =>
            editingId === link.id && canWrite ? (
              <EditLinkRow
                key={link.id}
                projectId={project.id}
                link={link}
                onDone={() => setEditingId(null)}
              />
            ) : (
              <LinkRow
                key={link.id}
                link={link}
                canWrite={canWrite}
                onEdit={canWrite ? () => setEditingId(link.id) : undefined}
                onDelete={() => {
                  if (confirm(`Remove the ${link.label} link?`)) del.mutate(link.id);
                }}
              />
            ),
          )}
        </ul>
      ) : null}

      {canWrite ? (
        adding ? (
          <AddLinkForm
            projectId={project.id}
            onDone={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-wp-stone bg-white px-2.5 py-1 text-xs text-wp-slate hover:border-wp-red/40 hover:text-wp-ink"
          >
            <Plus size={12} />
            Add link
          </button>
        )
      ) : null}
    </section>
  );
}

/** Strip the scheme from a URL for display so rows stay compact.
 *  The `href` still carries the original URL; only the visible text
 *  is trimmed. Falls back to the raw string if URL parsing fails
 *  (belt and suspenders — the backend already validates on write). */
function displayUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const rest = parsed.host + parsed.pathname + parsed.search + parsed.hash;
    return rest.replace(/\/$/, "");
  } catch {
    return u.replace(/^https?:\/\//, "");
  }
}

function LinkRow({
  link,
  canWrite,
  onEdit,
  onDelete,
}: {
  link: ProjectLink;
  canWrite: boolean;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-wp-stone bg-white px-2.5 py-1.5 text-xs text-wp-ink hover:border-wp-red/30">
      <span className="inline-flex shrink-0 items-center rounded-full border border-wp-stone bg-wp-stone/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-wp-slate">
        {link.label}
      </span>
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        title={link.url}
        className="min-w-0 flex-1 truncate text-wp-ink underline decoration-wp-stone underline-offset-2 hover:decoration-wp-red hover:text-wp-red"
      >
        {displayUrl(link.url)}
      </a>
      {canWrite ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${link.label} link`}
            className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-wp-ink"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Remove ${link.label} link`}
            className="rounded p-1 text-wp-slate hover:bg-wp-stone/30 hover:text-red-600"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Inline edit form — same shape as AddLinkForm below so users
 * see consistent controls. Save PATCHes and returns the row to
 * display mode; Cancel discards edits without touching the row.
 */
function EditLinkRow({
  projectId,
  link,
  onDone,
}: {
  projectId: string;
  link: ProjectLink;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(link.label);
  const [url, setUrl] = useState(link.url);
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: () =>
      api<ProjectLink>(`/links/${link.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label, url }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectLinks", projectId] });
      qc.invalidateQueries({ queryKey: ["projectHistory", projectId] });
      qc.invalidateQueries({ queryKey: ["linkLabelSuggestions"] });
      onDone();
    },
  });

  const dirty = label.trim() !== link.label || url.trim() !== link.url;
  const canSubmit = dirty && !!label.trim() && !!url.trim() && !save.isPending;

  return (
    <li className="rounded-md border border-wp-red/60 bg-wp-stone/20 p-2.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) save.mutate();
        }}
        className="space-y-2"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[11px] text-wp-slate">
            <span className="mb-0.5">Label</span>
            <LinkLabelPicker
              value={label}
              onChange={setLabel}
              className="w-40"
              autoFocus
            />
          </label>
          <label className="flex flex-1 flex-col text-[11px] text-wp-slate">
            <span className="mb-0.5">URL</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
            />
          </label>
          <div className="flex items-center gap-1">
            <button type="submit" className="btn-primary text-xs" disabled={!canSubmit}>
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={onDone}
              disabled={save.isPending}
            >
              <X size={12} />
              Cancel
            </button>
          </div>
        </div>
        {save.isError ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
            {(save.error as Error).message}
          </div>
        ) : null}
      </form>
    </li>
  );
}

function AddLinkForm({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const [label, setLabel] = useState<string>(DEFAULT_NEW_LABEL);
  const [url, setUrl] = useState<string>("");
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api<ProjectLink>(`/projects/${projectId}/links`, {
        method: "POST",
        body: JSON.stringify({ label, url }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projectLinks", projectId] });
      qc.invalidateQueries({ queryKey: ["projectHistory", projectId] });
      qc.invalidateQueries({ queryKey: ["linkLabelSuggestions"] });
      onDone();
    },
  });

  const canSubmit = !!label.trim() && !!url.trim() && !create.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) create.mutate();
      }}
      className="mt-3 space-y-2 rounded-md border border-wp-stone bg-wp-stone/20 p-2.5"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">Label</span>
          <LinkLabelPicker
            value={label}
            onChange={setLabel}
            className="w-40"
          />
        </label>
        <label className="flex flex-1 flex-col text-[11px] text-wp-slate">
          <span className="mb-0.5">URL</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            autoFocus
            className="rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink"
          />
        </label>
        <div className="flex items-center gap-1">
          <button type="submit" className="btn-secondary text-xs" disabled={!canSubmit}>
            {create.isPending ? "Adding…" : "Add link"}
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={onDone}
            disabled={create.isPending}
          >
            <X size={12} />
            Cancel
          </button>
        </div>
      </div>
      {create.isError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {(create.error as Error).message}
        </div>
      ) : null}
    </form>
  );
}
