import { ExternalLink, RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useIsAdmin } from "../lib/queries";
import type { Project } from "../lib/types";
import { MutationErrorBanner } from "./MutationErrorBanner";

type JiraSyncStatus = {
  active: boolean;
  base_url: string | null;
};

/**
 * Compact Jira identity + sync error on the project detail panel.
 * Admins can force a sync / attach a key.
 */
export function JiraSyncPanel({ project }: { project: Project }) {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [keyDraft, setKeyDraft] = useState(project.jira_key ?? "");
  const status = useQuery({
    queryKey: ["jiraSyncStatus"],
    queryFn: () => api<JiraSyncStatus>("/jira-sync/status"),
    staleTime: 60_000,
    enabled: isAdmin || !!project.jira_key || !!project.jira_sync_error,
  });

  const sync = useMutation({
    mutationFn: (body?: { jira_key?: string }) =>
      api<{ jira_url?: string | null }>(`/jira-sync/projects/${project.id}/sync`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      qc.invalidateQueries({ queryKey: ["projectLinks", project.id] });
      qc.invalidateQueries({ queryKey: ["jiraSyncStatus"] });
    },
  });

  const base = status.data?.base_url?.replace(/\/$/, "") ?? "";
  const browseUrl =
    project.jira_key && base ? `${base}/browse/${project.jira_key}` : null;

  // Hide the whole block when sync is off and there's nothing to show.
  if (
    !project.jira_key &&
    !project.jira_sync_error &&
    !isAdmin &&
    status.data &&
    !status.data.active
  ) {
    return null;
  }

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-wp-ink">Jira</h3>
        {project.jira_key ? (
          browseUrl ? (
            <a
              href={browseUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-wp-stone bg-white px-2 py-0.5 text-xs font-medium text-wp-ink hover:border-wp-red/40"
            >
              {project.jira_key}
              <ExternalLink size={11} />
            </a>
          ) : (
            <span className="rounded-full border border-wp-stone bg-white px-2 py-0.5 text-xs font-medium text-wp-ink">
              {project.jira_key}
            </span>
          )
        ) : (
          <span className="text-xs text-wp-slate">Not linked</span>
        )}
        {project.jira_sync_error ? (
          <span
            className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700"
            title={project.jira_sync_error}
          >
            Sync error
          </span>
        ) : project.jira_synced_at ? (
          <span className="text-[11px] text-wp-slate">
            Synced {new Date(project.jira_synced_at).toLocaleString()}
          </span>
        ) : null}
      </div>

      {project.jira_sync_error ? (
        <p className="mt-1 text-xs text-red-700">{project.jira_sync_error}</p>
      ) : null}

      {isAdmin ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label
              className="text-[11px] font-medium text-wp-slate"
              htmlFor={`jira-key-${project.id}`}
            >
              Issue key
            </label>
            <input
              id={`jira-key-${project.id}`}
              className="input mt-0.5 w-36"
              placeholder="SHOP-123"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1 text-xs"
            disabled={sync.isPending}
            onClick={() =>
              sync.mutate(
                keyDraft.trim() && keyDraft.trim() !== (project.jira_key ?? "")
                  ? { jira_key: keyDraft.trim() }
                  : {},
              )
            }
          >
            <RefreshCw size={12} className={sync.isPending ? "animate-spin" : undefined} />
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        </div>
      ) : null}

      <MutationErrorBanner mutation={sync} className="mt-2" />
    </section>
  );
}
