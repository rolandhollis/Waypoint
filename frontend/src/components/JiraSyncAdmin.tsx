import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { MutationErrorBanner } from "./MutationErrorBanner";

type JiraSyncStatus = {
  enabled: boolean;
  configured: boolean;
  active: boolean;
  project_key: string | null;
  base_url: string | null;
  pending_outbox: number;
  done_statuses: string[];
};

/**
 * Admin → Jira sync: status + manual drain / reconcile / link backfill.
 * Credentials live in env (JIRA_*); this UI does not store secrets.
 */
export function JiraSyncAdmin() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["jiraSyncStatus"],
    queryFn: () => api<JiraSyncStatus>("/jira-sync/status"),
    refetchInterval: 15_000,
  });

  const drain = useMutation({
    mutationFn: () => api<{ drained: number }>("/jira-sync/drain", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jiraSyncStatus"] }),
  });
  const reconcile = useMutation({
    mutationFn: () => api<{ applied: number }>("/jira-sync/reconcile", { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jiraSyncStatus"] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const backfill = useMutation({
    mutationFn: () =>
      api<{ scanned: number; linked: number }>("/jira-sync/backfill-links", {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });

  const s = status.data;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-wp-ink">Jira sync</h2>
        <p className="mt-1 text-xs text-wp-slate">
          Automatic Waypoint ↔ Jira Software epic sync. Enable with{" "}
          <code className="rounded bg-wp-stone/40 px-1">JIRA_SYNC_ENABLED=true</code> and
          Atlassian credentials in the API environment. Prefer a sandbox project key while
          testing locally.
        </p>
      </div>

      {status.isLoading ? (
        <p className="text-sm text-wp-slate">Loading sync status…</p>
      ) : (
        <dl className="grid max-w-xl grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-wp-slate">Active</dt>
          <dd className="font-medium text-wp-ink">{s?.active ? "Yes" : "No"}</dd>
          <dt className="text-wp-slate">Env enabled</dt>
          <dd className="text-wp-ink">{s?.enabled ? "true" : "false"}</dd>
          <dt className="text-wp-slate">Credentials</dt>
          <dd className="text-wp-ink">{s?.configured ? "configured" : "incomplete"}</dd>
          <dt className="text-wp-slate">Jira project</dt>
          <dd className="text-wp-ink">{s?.project_key ?? "—"}</dd>
          <dt className="text-wp-slate">Site</dt>
          <dd className="truncate text-wp-ink">{s?.base_url ?? "—"}</dd>
          <dt className="text-wp-slate">Pending outbox</dt>
          <dd className="text-wp-ink">{s?.pending_outbox ?? 0}</dd>
          <dt className="text-wp-slate">Done statuses</dt>
          <dd className="text-wp-ink">{(s?.done_statuses ?? []).join(", ") || "—"}</dd>
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary text-sm"
          disabled={!s?.active || drain.isPending}
          onClick={() => drain.mutate()}
        >
          {drain.isPending ? "Draining…" : "Drain outbox now"}
        </button>
        <button
          type="button"
          className="btn-secondary text-sm"
          disabled={!s?.active || reconcile.isPending}
          onClick={() => reconcile.mutate()}
        >
          {reconcile.isPending ? "Reconciling…" : "Reconcile now"}
        </button>
        <button
          type="button"
          className="btn-secondary text-sm"
          disabled={backfill.isPending}
          onClick={() => backfill.mutate()}
        >
          {backfill.isPending ? "Backfilling…" : "Backfill keys from links"}
        </button>
      </div>

      {drain.isSuccess ? (
        <p className="text-xs text-wp-slate">Drained {drain.data.drained} outbox row(s).</p>
      ) : null}
      {reconcile.isSuccess ? (
        <p className="text-xs text-wp-slate">
          Applied {reconcile.data.applied} inbound status update(s).
        </p>
      ) : null}
      {backfill.isSuccess ? (
        <p className="text-xs text-wp-slate">
          Scanned {backfill.data.scanned} link(s), linked {backfill.data.linked} project(s).
        </p>
      ) : null}

      <MutationErrorBanner mutation={drain} />
      <MutationErrorBanner mutation={reconcile} />
      <MutationErrorBanner mutation={backfill} />

      <div className="rounded-md border border-wp-stone/80 bg-wp-stone/5 p-3 text-xs text-wp-slate">
        <p className="font-medium text-wp-ink">Webhook (production)</p>
        <p className="mt-1">
          Point a Jira issue updated webhook at{" "}
          <code className="rounded bg-white px-1">POST /api/webhooks/jira?token=…</code>{" "}
          using <code className="rounded bg-white px-1">JIRA_WEBHOOK_SECRET</code>. Inbound
          sync only moves Waypoint cards when Jira status is in the Done list above.
        </p>
      </div>
    </div>
  );
}
