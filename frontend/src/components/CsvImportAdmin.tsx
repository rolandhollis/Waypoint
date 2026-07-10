import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";
import { api } from "../lib/api";
import { useTeams, useUsers } from "../lib/queries";

/**
 * Admin-only CSV importer for backlog items. Two-phase UX:
 *
 *  1. Upload — a hidden <input type="file"> triggered by a custom
 *     styled button. On selection we read the file client-side
 *     (small enough — capped at ~5MB by the backend zod schema),
 *     POST the raw text to /imports/csv/preview, and the server
 *     returns a fully-resolved per-row report.
 *
 *  2. Review — render each row as a checkable card. Rows with
 *     errors are unchecked + disabled and display their errors
 *     inline in red. The "Import N items" button at the bottom
 *     ships only the checked rows to /imports/csv/commit.
 *
 * A fatal structural error (unparseable CSV, missing required
 * column, empty file) short-circuits step 2 with a red banner.
 */

type ResolvedRow = {
  title: string;
  description: string | null;
  owner_id: string | null;
  team_ids: string[];
  tags: string[];
  start_date: string | null;
  target_date: string | null;
  dev_start_date: string | null;
  dev_end_date: string | null;
  optimization_start_date: string | null;
  optimization_end_date: string | null;
};

type PreviewRow = {
  line: number;
  raw: Record<string, string>;
  resolved: ResolvedRow | null;
  errors: string[];
  warnings: string[];
};

type PreviewResponse = {
  headers: string[];
  known_columns: string[];
  unknown_columns: string[];
  rows: PreviewRow[];
};

type CommitResponse = {
  lane_id: string;
  lane_name: string;
  results: Array<
    | { status: "created"; project_id: string; title: string }
    | { status: "failed"; title: string; error: string }
  >;
  created_count: number;
  failed_count: number;
};

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "reviewing"; filename: string; preview: PreviewResponse; checked: Set<number> }
  | { kind: "committing"; filename: string; preview: PreviewResponse; checked: Set<number> }
  | { kind: "done"; filename: string; result: CommitResponse };

export function CsvImportAdmin() {
  const users = useUsers();
  const teams = useTeams();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [fatal, setFatal] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const previewMutation = useMutation<PreviewResponse, Error, { csv: string; filename: string }>({
    mutationFn: ({ csv }) =>
      api<PreviewResponse>("/imports/csv/preview", {
        method: "POST",
        body: JSON.stringify({ csv }),
      }),
    onSuccess: (data, vars) => {
      // Auto-check every row that resolved cleanly; leave rows with
      // errors unchecked (the checkbox will also be disabled below).
      const checked = new Set<number>();
      data.rows.forEach((r) => {
        if (!r.errors.length && r.resolved) checked.add(r.line);
      });
      setPhase({ kind: "reviewing", filename: vars.filename, preview: data, checked });
      setFatal(null);
    },
    onError: (err) => {
      setFatal(err.message);
      setPhase({ kind: "idle" });
    },
  });

  const commitMutation = useMutation<CommitResponse, Error, ResolvedRow[]>({
    mutationFn: (rows) =>
      api<CommitResponse>("/imports/csv/commit", {
        method: "POST",
        body: JSON.stringify({ rows }),
      }),
    onSuccess: (result) => {
      // A commit always touches the project list, so nuke the cached
      // list; the Roadmap / Board will refetch on their next tick.
      qc.invalidateQueries({ queryKey: ["projects"] });
      setPhase((prev) => {
        if (prev.kind !== "committing" && prev.kind !== "reviewing") return prev;
        return { kind: "done", filename: prev.filename, result };
      });
    },
    onError: (err) => {
      setFatal(err.message);
      // Return the user to the review phase with their selection intact.
      setPhase((prev) => (prev.kind === "committing"
        ? { kind: "reviewing", filename: prev.filename, preview: prev.preview, checked: prev.checked }
        : prev));
    },
  });

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFatal(null);
    setPhase({ kind: "uploading", filename: file.name });
    try {
      const text = await file.text();
      previewMutation.mutate({ csv: text, filename: file.name });
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      setPhase({ kind: "idle" });
    }
  }

  function reset() {
    setPhase({ kind: "idle" });
    setFatal(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function toggleRow(line: number) {
    setPhase((prev) => {
      if (prev.kind !== "reviewing") return prev;
      const next = new Set(prev.checked);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return { ...prev, checked: next };
    });
  }

  function setAllChecked(all: boolean) {
    setPhase((prev) => {
      if (prev.kind !== "reviewing") return prev;
      const next = new Set<number>();
      if (all) {
        for (const r of prev.preview.rows) {
          if (!r.errors.length && r.resolved) next.add(r.line);
        }
      }
      return { ...prev, checked: next };
    });
  }

  function commit() {
    if (phase.kind !== "reviewing") return;
    const rows = phase.preview.rows
      .filter((r) => phase.checked.has(r.line) && r.resolved)
      .map((r) => r.resolved as ResolvedRow);
    if (rows.length === 0) return;
    setPhase({ ...phase, kind: "committing" });
    commitMutation.mutate(rows);
  }

  return (
    <section className="card-surface p-4">
      <h2 className="text-base font-semibold">Import CSV</h2>
      <p className="mt-1 text-xs text-wp-slate">
        Bulk-create backlog items from a CSV. Rows land in the default swim lane as epics.
      </p>

      {/* Schema reference — collapsed by default via <details> so it
          stays out of the way once someone is familiar with it. */}
      <details className="mt-3 rounded-md border border-wp-stone bg-wp-cloud/30 px-3 py-2 text-xs text-wp-slate">
        <summary className="cursor-pointer font-medium text-wp-ink">Expected columns</summary>
        <div className="mt-2 space-y-1">
          <div>
            <span className="font-medium text-wp-ink">Required:</span> <code className="rounded bg-white px-1">title</code>
          </div>
          <div>
            <span className="font-medium text-wp-ink">Optional:</span>{" "}
            <code className="rounded bg-white px-1">description</code>,{" "}
            <code className="rounded bg-white px-1">owner_email</code>,{" "}
            <code className="rounded bg-white px-1">teams</code> (comma-separated names),{" "}
            <code className="rounded bg-white px-1">tags</code> (comma-separated),{" "}
            <code className="rounded bg-white px-1">start_date</code>,{" "}
            <code className="rounded bg-white px-1">target_date</code>,{" "}
            <code className="rounded bg-white px-1">dev_start_date</code>,{" "}
            <code className="rounded bg-white px-1">dev_end_date</code>,{" "}
            <code className="rounded bg-white px-1">optimization_start_date</code>,{" "}
            <code className="rounded bg-white px-1">optimization_end_date</code>
          </div>
          <div>Dates accept ISO (2026-08-15) or MM/DD/YYYY. Unknown columns are ignored.</div>
          <div>All imported rows become epics — restructure into subtasks afterwards in the board.</div>
        </div>
      </details>

      {/* Hidden native input driven by the styled button. Kept in the
          DOM at all times so the file picker still works after we
          navigate back to phase=idle from the done screen. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          handleFile(file);
          // Reset the input so re-picking the same file re-fires onChange.
          e.target.value = "";
        }}
      />

      {fatal ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-600" />
          <div>
            <div className="font-semibold">CSV import failed</div>
            <div className="mt-0.5">{fatal}</div>
          </div>
        </div>
      ) : null}

      {phase.kind === "idle" ? (
        <div className="mt-4 flex flex-col items-start gap-2">
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-2"
            onClick={pickFile}
          >
            <Upload size={14} />
            Choose CSV file
          </button>
          <div className="text-xs text-wp-slate">CSV up to ~5 MB, first row must contain the column headers.</div>
        </div>
      ) : null}

      {phase.kind === "uploading" ? (
        <div className="mt-4 inline-flex items-center gap-2 text-sm text-wp-slate">
          <Loader2 size={14} className="animate-spin" />
          Validating <span className="font-medium text-wp-ink">{phase.filename}</span>…
        </div>
      ) : null}

      {phase.kind === "reviewing" || phase.kind === "committing" ? (
        <ReviewList
          phase={phase}
          onToggleRow={toggleRow}
          onSetAllChecked={setAllChecked}
          onCommit={commit}
          onReset={reset}
          userNameById={new Map((users.data ?? []).map((u) => [u.id, u.name]))}
          teamNameById={new Map((teams.data ?? []).map((t) => [t.id, t.name]))}
        />
      ) : null}

      {phase.kind === "done" ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-800">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-600" />
            <div>
              <div className="font-semibold">
                Imported {phase.result.created_count}{" "}
                {phase.result.created_count === 1 ? "item" : "items"} into “{phase.result.lane_name}”
              </div>
              {phase.result.failed_count > 0 ? (
                <div className="mt-0.5">{phase.result.failed_count} row(s) failed and were skipped.</div>
              ) : null}
            </div>
          </div>
          {phase.result.failed_count > 0 ? (
            <ul className="space-y-1 text-xs text-red-800">
              {phase.result.results
                .filter((r): r is Extract<CommitResponse["results"][number], { status: "failed" }> => r.status === "failed")
                .map((r, i) => (
                  <li key={i}>
                    <span className="font-medium">{r.title}</span> — {r.error}
                  </li>
                ))}
            </ul>
          ) : null}
          <button type="button" className="btn-secondary text-xs" onClick={reset}>
            Import another file
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ReviewList(props: {
  phase: Extract<Phase, { kind: "reviewing" | "committing" }>;
  onToggleRow: (line: number) => void;
  onSetAllChecked: (all: boolean) => void;
  onCommit: () => void;
  onReset: () => void;
  userNameById: Map<string, string>;
  teamNameById: Map<string, string>;
}) {
  const { phase, onToggleRow, onSetAllChecked, onCommit, onReset, userNameById, teamNameById } = props;
  const totalRows = phase.preview.rows.length;
  const importable = phase.preview.rows.filter((r) => !r.errors.length && r.resolved).length;
  const checkedCount = phase.checked.size;
  const isCommitting = phase.kind === "committing";

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-wp-slate">
        <div>
          <span className="font-medium text-wp-ink">{phase.filename}</span> —{" "}
          {totalRows} row{totalRows === 1 ? "" : "s"} parsed
          {totalRows - importable > 0 ? (
            <span className="text-red-700"> ({totalRows - importable} with errors)</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-wp-ink underline decoration-dotted underline-offset-2"
            onClick={() => onSetAllChecked(true)}
            disabled={isCommitting}
          >
            Select all valid
          </button>
          <span aria-hidden className="text-wp-stone">|</span>
          <button
            type="button"
            className="text-xs text-wp-ink underline decoration-dotted underline-offset-2"
            onClick={() => onSetAllChecked(false)}
            disabled={isCommitting}
          >
            Deselect all
          </button>
        </div>
      </div>

      {phase.preview.unknown_columns.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Ignored unknown column{phase.preview.unknown_columns.length === 1 ? "" : "s"}:{" "}
          <code className="rounded bg-white px-1">
            {phase.preview.unknown_columns.join(", ")}
          </code>
        </div>
      ) : null}

      <ul className="max-h-[420px] overflow-y-auto divide-y divide-wp-stone rounded-md border border-wp-stone bg-white">
        {phase.preview.rows.map((row) => {
          const hasErrors = row.errors.length > 0 || !row.resolved;
          const isChecked = phase.checked.has(row.line);
          return (
            <li
              key={row.line}
              className={
                "flex items-start gap-3 px-3 py-2 " +
                (hasErrors ? "bg-red-50/40" : "hover:bg-wp-cloud/40")
              }
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-wp-red disabled:cursor-not-allowed"
                checked={isChecked}
                disabled={hasErrors || isCommitting}
                onChange={() => onToggleRow(row.line)}
                aria-label={`Include row ${row.line}: ${row.raw.title || "(no title)"}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xs text-wp-slate">Line {row.line}</span>
                  <span className="text-sm font-medium text-wp-ink truncate">
                    {row.raw.title || <em className="text-wp-slate">(missing title)</em>}
                  </span>
                </div>
                <RowSummary
                  resolved={row.resolved}
                  raw={row.raw}
                  userNameById={userNameById}
                  teamNameById={teamNameById}
                />
                {row.errors.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-red-700">
                    {row.errors.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={onReset} disabled={isCommitting}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary inline-flex items-center gap-2"
          onClick={onCommit}
          disabled={isCommitting || checkedCount === 0}
        >
          {isCommitting ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
          {isCommitting
            ? "Importing…"
            : `Import ${checkedCount} ${checkedCount === 1 ? "item" : "items"}`}
        </button>
      </div>
    </div>
  );
}

function RowSummary({
  resolved,
  raw,
  userNameById,
  teamNameById,
}: {
  resolved: ResolvedRow | null;
  raw: Record<string, string>;
  userNameById: Map<string, string>;
  teamNameById: Map<string, string>;
}) {
  if (!resolved) return null;
  const parts: string[] = [];
  if (resolved.owner_id) {
    parts.push(`owner: ${userNameById.get(resolved.owner_id) ?? raw.owner_email ?? "?"}`);
  }
  if (resolved.team_ids.length) {
    const names = resolved.team_ids
      .map((id) => teamNameById.get(id))
      .filter((n): n is string => !!n);
    if (names.length) parts.push(`teams: ${names.join(", ")}`);
  }
  if (resolved.tags.length) parts.push(`tags: ${resolved.tags.join(", ")}`);
  const dateWindow = [resolved.start_date, resolved.optimization_end_date ?? resolved.dev_end_date ?? resolved.target_date]
    .filter(Boolean)
    .join(" → ");
  if (dateWindow) parts.push(dateWindow);
  if (parts.length === 0) return null;
  return <div className="mt-0.5 text-xs text-wp-slate">{parts.join(" · ")}</div>;
}
