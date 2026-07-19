import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { useAiReferenceEstimates, useProjects } from "../lib/queries";
import type { AiReferenceEstimate } from "../lib/types";
import { MutationErrorBanner } from "./MutationErrorBanner";

/**
 * Admin section for the curated AI reference-estimate catalog that
 * seeds the phase-size suggester's few-shot prompt (see
 * backend/src/routes/aiReferenceEstimates.ts +
 * backend/src/ai/estimator.ts). Curated rows land FIRST in the
 * prompt, ahead of engineer-confirmed historical projects, so the
 * quality here directly shapes every subsequent Suggest click.
 *
 * Four sub-panels, top-to-bottom:
 *   1. Count chip — "N curated · M historical" so admins can eyeball
 *      whether the pool is thin.
 *   2. Upload panel — CSV picker + a preview table with per-row
 *      checkboxes; commit only the checked+valid rows.
 *   3. Existing catalog list — sortable via drag; each row edits or
 *      deletes in place. Manual "Add estimate" button opens the
 *      same modal used for edits.
 */

// ------------------------------------------------------------------
// CSV column contract — kept in one place so the reference block and
// the preview UI stay in sync. Also mirrored in the backend at
// backend/src/routes/aiReferenceEstimates.ts.
// ------------------------------------------------------------------
const CSV_HEADERS = [
  "title",
  "description",
  "discovery_days",
  "development_days",
  "post_dev_days",
  "notes",
  "source_label",
] as const;

// ------------------------------------------------------------------
// Types echoing the backend router shapes.
// ------------------------------------------------------------------
type ReferenceInput = {
  title: string;
  description: string;
  discovery_days: number | null;
  development_days: number | null;
  post_dev_days: number | null;
  notes: string | null;
  source_label: string | null;
};

type PreviewRow = {
  index: number;
  valid: boolean;
  error?: string;
  parsed?: ReferenceInput;
  raw: Record<string, string>;
};

type PreviewResponse = { rows: PreviewRow[] };
type CommitResponse = { createdCount: number };

type UploadPhase =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "reviewing"; filename: string; preview: PreviewResponse; checked: Set<number> }
  | { kind: "committing"; filename: string; preview: PreviewResponse; checked: Set<number> }
  | { kind: "done"; filename: string; result: CommitResponse };

// ------------------------------------------------------------------
// Panel entry point.
// ------------------------------------------------------------------
export function AiReferenceEstimatesAdmin() {
  const refs = useAiReferenceEstimates();
  const projects = useProjects();
  const qc = useQueryClient();

  const [editing, setEditing] = useState<AiReferenceEstimate | null>(null);
  const [creating, setCreating] = useState(false);

  const create = useMutation({
    mutationFn: (body: ReferenceInput) =>
      api<AiReferenceEstimate>("/ai-reference-estimates", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aiReferenceEstimates"] }),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: ReferenceInput }) =>
      api<AiReferenceEstimate>(`/ai-reference-estimates/${v.id}`, {
        method: "PATCH",
        body: JSON.stringify(v.body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aiReferenceEstimates"] }),
  });
  const del = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/ai-reference-estimates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aiReferenceEstimates"] }),
  });
  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      api<{ ok: true }>("/ai-reference-estimates/reorder", {
        method: "POST",
        body: JSON.stringify({ orderedIds }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aiReferenceEstimates"] }),
  });

  const rows = refs.data ?? [];
  const historicalConfirmedCount = useMemo(
    () =>
      (projects.data ?? []).filter(
        (p) =>
          p.dev_estimate_sourced_by_dev &&
          !p.deleted_at &&
          p.start_date &&
          p.dev_end_date &&
          p.optimization_end_date,
      ).length,
    [projects.data],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = rows.findIndex((r) => r.id === active.id);
    const newIdx = rows.findIndex((r) => r.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const orderedIds = arrayMove(rows, oldIdx, newIdx).map((r) => r.id);
    reorder.mutate(orderedIds);
  }

  return (
    <section className="card-surface p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <Sparkles size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-wp-ink">
              AI reference estimates
            </h2>
            <span
              className="rounded-full bg-wp-stone/40 px-2 py-0.5 text-[11px] text-wp-slate"
              title="Total examples that seed the Claude few-shot prompt: hand-curated rows here + historical projects flagged 'Dev estimate confirmed by engineering'."
            >
              {rows.length} curated · {historicalConfirmedCount} historical
            </span>
          </div>
          <p className="mt-1 text-xs text-wp-slate">
            Hand-curated examples that seed the phase-size suggester (
            <em>EZEstimates → ✨ Suggest</em>). Rendered FIRST in the prompt,
            ahead of engineer-confirmed historical projects. Upload a CSV or
            add entries manually.
          </p>
        </div>
      </div>

      <UploadPanel />

      <div className="mt-6 border-t border-wp-stone/60 pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-wp-ink">Current catalog</h3>
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1.5 text-xs"
            onClick={() => setCreating(true)}
          >
            <Plus size={13} />
            Add estimate
          </button>
        </div>

        <MutationErrorBanner mutation={create} className="mt-3" />
        <MutationErrorBanner mutation={patch} className="mt-3" />
        <MutationErrorBanner mutation={del} className="mt-3" />
        <MutationErrorBanner mutation={reorder} className="mt-3" />

        {refs.isLoading ? (
          <p className="mt-3 text-xs text-wp-slate">Loading reference estimates…</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-wp-stone px-3 py-4 text-xs text-wp-slate">
            No curated reference estimates yet. Add one manually or upload a
            CSV above. Until at least one row exists here, the suggester
            falls back on engineer-confirmed historical projects only.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={rows.map((r) => r.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="mt-3 divide-y divide-wp-stone rounded-md border border-wp-stone bg-white">
                {rows.map((r) => (
                  <SortableRefRow
                    key={r.id}
                    row={r}
                    onEdit={() => setEditing(r)}
                    onDelete={() => {
                      if (
                        confirm(
                          `Delete curated reference "${r.title}"? This immediately removes it from the AI suggester's few-shot pool.`,
                        )
                      ) {
                        del.mutate(r.id);
                      }
                    }}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {creating ? (
        <RefEstimateModal
          onClose={() => setCreating(false)}
          onSubmit={async (body) => {
            await create.mutateAsync(body);
            setCreating(false);
          }}
          submitLabel="Create"
        />
      ) : null}

      {editing ? (
        <RefEstimateModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (body) => {
            await patch.mutateAsync({ id: editing.id, body });
            setEditing(null);
          }}
          submitLabel="Save changes"
        />
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------
// Upload panel — CSV picker + preview + commit.
// ------------------------------------------------------------------
function UploadPanel() {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<UploadPhase>({ kind: "idle" });
  const [fatal, setFatal] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const preview = useMutation<PreviewResponse, Error, { csv: string; filename: string }>({
    mutationFn: ({ csv }) =>
      api<PreviewResponse>("/ai-reference-estimates/import/preview", {
        method: "POST",
        body: JSON.stringify({ csv }),
      }),
    onSuccess: (data, vars) => {
      const checked = new Set<number>();
      data.rows.forEach((r) => {
        if (r.valid && r.parsed) checked.add(r.index);
      });
      setPhase({ kind: "reviewing", filename: vars.filename, preview: data, checked });
      setFatal(null);
    },
    onError: (err) => {
      setFatal(err.message);
      setPhase({ kind: "idle" });
    },
  });

  const commit = useMutation<CommitResponse, Error, ReferenceInput[]>({
    mutationFn: (rows) =>
      api<CommitResponse>("/ai-reference-estimates/import/commit", {
        method: "POST",
        body: JSON.stringify({ rows }),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["aiReferenceEstimates"] });
      setPhase((prev) => {
        if (prev.kind !== "committing" && prev.kind !== "reviewing") return prev;
        return { kind: "done", filename: prev.filename, result };
      });
    },
    onError: (err) => {
      setFatal(err.message);
      setPhase((prev) =>
        prev.kind === "committing"
          ? { kind: "reviewing", filename: prev.filename, preview: prev.preview, checked: prev.checked }
          : prev,
      );
    },
  });

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFatal(null);
    setPhase({ kind: "uploading", filename: file.name });
    try {
      const text = await file.text();
      preview.mutate({ csv: text, filename: file.name });
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

  function toggleRow(index: number) {
    setPhase((prev) => {
      if (prev.kind !== "reviewing") return prev;
      const next = new Set(prev.checked);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return { ...prev, checked: next };
    });
  }

  function setAllChecked(all: boolean) {
    setPhase((prev) => {
      if (prev.kind !== "reviewing") return prev;
      const next = new Set<number>();
      if (all) {
        for (const r of prev.preview.rows) {
          if (r.valid && r.parsed) next.add(r.index);
        }
      }
      return { ...prev, checked: next };
    });
  }

  function doCommit() {
    if (phase.kind !== "reviewing") return;
    const rows = phase.preview.rows
      .filter((r) => phase.checked.has(r.index) && r.valid && r.parsed)
      .map((r) => r.parsed as ReferenceInput);
    if (rows.length === 0) return;
    setPhase({ ...phase, kind: "committing" });
    commit.mutate(rows);
  }

  return (
    <div className="mt-4 rounded-md border border-wp-stone bg-wp-cloud/20 p-3">
      <div className="flex items-center gap-2">
        <Upload size={14} className="text-wp-slate" />
        <span className="text-sm font-semibold text-wp-ink">Upload CSV</span>
      </div>
      <details className="mt-2 rounded-md border border-wp-stone bg-white px-3 py-2 text-xs text-wp-slate">
        <summary className="cursor-pointer font-medium text-wp-ink">
          Expected columns
        </summary>
        <div className="mt-2 space-y-1">
          <div>
            <span className="font-medium text-wp-ink">Header row (exact, case-insensitive):</span>{" "}
            <code className="rounded bg-wp-stone/30 px-1">
              {CSV_HEADERS.join(",")}
            </code>
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              <code className="rounded bg-wp-stone/30 px-1">title</code> — required, non-empty.
            </li>
            <li>
              <code className="rounded bg-wp-stone/30 px-1">description</code> — optional (empty string if blank).
            </li>
            <li>
              <code className="rounded bg-wp-stone/30 px-1">discovery_days</code>,{" "}
              <code className="rounded bg-wp-stone/30 px-1">development_days</code>,{" "}
              <code className="rounded bg-wp-stone/30 px-1">post_dev_days</code> — integer or blank.
              Blank means "not included for this phase." <b>At least one must be non-blank.</b>
            </li>
            <li>
              <code className="rounded bg-wp-stone/30 px-1">notes</code>,{" "}
              <code className="rounded bg-wp-stone/30 px-1">source_label</code> — optional context
              carried into the prompt as an inline <code className="rounded bg-wp-stone/30 px-1"># Notes:</code> hint.
            </li>
            <li>Whitespace is trimmed on every field. Extra columns are rejected.</li>
          </ul>
        </div>
      </details>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          handleFile(file);
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
        <div className="mt-3 flex flex-col items-start gap-2">
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-2"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={14} />
            Choose CSV file
          </button>
          <div className="text-xs text-wp-slate">
            CSV up to ~5 MB. First row must contain the exact header shown above.
          </div>
        </div>
      ) : null}

      {phase.kind === "uploading" ? (
        <div className="mt-3 inline-flex items-center gap-2 text-sm text-wp-slate">
          <Loader2 size={14} className="animate-spin" />
          Validating <span className="font-medium text-wp-ink">{phase.filename}</span>…
        </div>
      ) : null}

      {phase.kind === "reviewing" || phase.kind === "committing" ? (
        <PreviewList
          phase={phase}
          onToggleRow={toggleRow}
          onSetAllChecked={setAllChecked}
          onCommit={doCommit}
          onReset={reset}
        />
      ) : null}

      {phase.kind === "done" ? (
        <div className="mt-3 space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-800">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-600" />
            <div className="font-semibold">
              Imported {phase.result.createdCount}{" "}
              reference estimate{phase.result.createdCount === 1 ? "" : "s"} from “{phase.filename}”.
            </div>
          </div>
          <button type="button" className="btn-secondary text-xs" onClick={reset}>
            Import another file
          </button>
        </div>
      ) : null}
    </div>
  );
}

function PreviewList(props: {
  phase: Extract<UploadPhase, { kind: "reviewing" | "committing" }>;
  onToggleRow: (index: number) => void;
  onSetAllChecked: (all: boolean) => void;
  onCommit: () => void;
  onReset: () => void;
}) {
  const { phase, onToggleRow, onSetAllChecked, onCommit, onReset } = props;
  const total = phase.preview.rows.length;
  const importable = phase.preview.rows.filter((r) => r.valid && r.parsed).length;
  const invalid = total - importable;
  const checkedCount = phase.checked.size;
  const isCommitting = phase.kind === "committing";

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-wp-slate">
        <div>
          <span className="font-medium text-wp-ink">{phase.filename}</span> —{" "}
          {total} row{total === 1 ? "" : "s"} parsed
          {invalid > 0 ? (
            <span className="text-red-700"> ({invalid} with errors)</span>
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

      <ul className="max-h-[420px] divide-y divide-wp-stone overflow-y-auto rounded-md border border-wp-stone bg-white">
        {phase.preview.rows.map((row) => {
          const isChecked = phase.checked.has(row.index);
          const hasError = !row.valid;
          return (
            <li
              key={row.index}
              className={
                "flex items-start gap-3 px-3 py-2 " +
                (hasError ? "bg-red-50/40" : "hover:bg-wp-cloud/40")
              }
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-wp-red disabled:cursor-not-allowed"
                checked={isChecked}
                disabled={hasError || isCommitting}
                onChange={() => onToggleRow(row.index)}
                aria-label={`Include row ${row.index + 1}: ${row.raw.title || "(no title)"}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xs text-wp-slate">Row {row.index + 1}</span>
                  <span className="truncate text-sm font-medium text-wp-ink">
                    {row.raw.title || <em className="text-wp-slate">(missing title)</em>}
                  </span>
                </div>
                <PreviewRowSummary row={row} />
                {hasError && row.error ? (
                  <p className="mt-1 text-xs text-red-700">• {row.error}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={onReset}
          disabled={isCommitting}
        >
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
            : `Import ${checkedCount} selected`}
        </button>
      </div>
    </div>
  );
}

function PreviewRowSummary({ row }: { row: PreviewRow }) {
  const parts: string[] = [];
  const p = row.parsed;
  if (p) {
    const days: string[] = [];
    if (p.discovery_days != null) days.push(`D=${p.discovery_days}d`);
    if (p.development_days != null) days.push(`Dev=${p.development_days}d`);
    if (p.post_dev_days != null) days.push(`PD=${p.post_dev_days}d`);
    if (days.length) parts.push(days.join(" · "));
    if (p.source_label) parts.push(`source: ${p.source_label}`);
    if (p.notes) parts.push(`notes: ${truncate(p.notes, 80)}`);
  }
  if (parts.length === 0) return null;
  return <div className="mt-0.5 text-xs text-wp-slate">{parts.join(" · ")}</div>;
}

// ------------------------------------------------------------------
// Sortable list row — mirrors the SwimLanesAdmin drag pattern.
// ------------------------------------------------------------------
function SortableRefRow(props: {
  row: AiReferenceEstimate;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { row, onEdit, onDelete } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="grid grid-cols-[auto_1fr_auto_auto_auto] items-start gap-3 px-3 py-2"
    >
      <button
        {...attributes}
        {...listeners}
        className="btn-ghost mt-1 !p-1 text-wp-slate"
        aria-label="Drag to reorder"
      >
        <GripVertical size={14} />
      </button>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-wp-ink">{row.title}</div>
        {row.description ? (
          <div
            className="mt-0.5 line-clamp-2 text-xs text-wp-slate"
            title={row.description}
          >
            {truncate(row.description, 260)}
          </div>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-wp-slate">
          {row.notes ? (
            <span
              className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-900"
              title={row.notes}
            >
              notes: {truncate(row.notes, 60)}
            </span>
          ) : null}
          {row.source_label ? (
            <span
              className="rounded-full bg-wp-cloud/50 px-2 py-0.5 text-wp-slate"
              title={row.source_label}
            >
              src: {truncate(row.source_label, 40)}
            </span>
          ) : null}
        </div>
      </div>
      <DaysMiniGrid row={row} />
      <button
        type="button"
        className="btn-ghost !p-1 text-wp-slate hover:text-wp-ink"
        aria-label={`Edit ${row.title}`}
        onClick={onEdit}
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        className="btn-ghost !p-1 text-red-600 hover:text-red-700"
        aria-label={`Delete ${row.title}`}
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function DaysMiniGrid({ row }: { row: AiReferenceEstimate }) {
  const cell = (label: string, val: number | null) => (
    <div
      className={
        "flex flex-col items-center rounded border px-2 py-0.5 text-[10px] " +
        (val == null
          ? "border-dashed border-wp-stone text-wp-slate/60"
          : "border-wp-stone bg-wp-cloud/40 text-wp-ink")
      }
    >
      <span className="font-semibold uppercase tracking-wide">{label}</span>
      <span className="font-mono text-xs">{val == null ? "—" : `${val}d`}</span>
    </div>
  );
  return (
    <div className="flex items-center gap-1">
      {cell("D", row.discovery_days)}
      {cell("Dev", row.development_days)}
      {cell("PD", row.post_dev_days)}
    </div>
  );
}

// ------------------------------------------------------------------
// Modal — used for BOTH create and edit. Plain inputs styled with
// the shared `input` class + `card-surface` overlay (matches the
// project's existing modal idiom; see NewProjectDialog for the same
// visual pattern).
// ------------------------------------------------------------------
function RefEstimateModal(props: {
  initial?: AiReferenceEstimate;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (body: ReferenceInput) => Promise<void>;
}) {
  const { initial, submitLabel, onClose, onSubmit } = props;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [discovery, setDiscovery] = useState<string>(
    initial?.discovery_days == null ? "" : String(initial.discovery_days),
  );
  const [development, setDevelopment] = useState<string>(
    initial?.development_days == null ? "" : String(initial.development_days),
  );
  const [postDev, setPostDev] = useState<string>(
    initial?.post_dev_days == null ? "" : String(initial.post_dev_days),
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [sourceLabel, setSourceLabel] = useState(initial?.source_label ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function toIntOrNull(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
    const t = raw.trim();
    if (!t) return { ok: true, value: null };
    if (!/^-?\d+$/.test(t)) return { ok: false, error: `"${t}" is not an integer` };
    const n = Number.parseInt(t, 10);
    if (n < 0) return { ok: false, error: "days must be >= 0" };
    if (n > 3650) return { ok: false, error: "days is unreasonably large (>3650)" };
    return { ok: true, value: n };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    const d = toIntOrNull(discovery);
    if (!d.ok) return setError(`discovery_days: ${d.error}`);
    const dev = toIntOrNull(development);
    if (!dev.ok) return setError(`development_days: ${dev.error}`);
    const pd = toIntOrNull(postDev);
    if (!pd.ok) return setError(`post_dev_days: ${pd.error}`);
    if (d.value == null && dev.value == null && pd.value == null) {
      setError("At least one of discovery / development / post-dev days must be set.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        discovery_days: d.value,
        development_days: dev.value,
        post_dev_days: pd.value,
        notes: notes.trim() || null,
        source_label: sourceLabel.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="mt-16 w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-wp-ink">
            {initial ? "Edit reference estimate" : "New reference estimate"}
          </h3>
          <button
            type="button"
            aria-label="Close"
            className="btn-ghost !p-1 text-wp-slate hover:text-wp-ink"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-3 space-y-3">
          <label className="block text-xs font-medium text-wp-slate">
            Title <span className="text-red-600">*</span>
            <input
              className="input mt-1 w-full"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q4 loyalty email campaign"
              autoFocus
            />
          </label>
          <label className="block text-xs font-medium text-wp-slate">
            Description
            <textarea
              className="input mt-1 w-full"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What did this project involve? Claude sees the first ~600 chars."
            />
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block text-xs font-medium text-wp-slate">
              Discovery days
              <input
                type="text"
                inputMode="numeric"
                className="input mt-1 w-full"
                value={discovery}
                onChange={(e) => setDiscovery(e.target.value)}
                placeholder="blank = n/a"
              />
            </label>
            <label className="block text-xs font-medium text-wp-slate">
              Development days
              <input
                type="text"
                inputMode="numeric"
                className="input mt-1 w-full"
                value={development}
                onChange={(e) => setDevelopment(e.target.value)}
                placeholder="blank = n/a"
              />
            </label>
            <label className="block text-xs font-medium text-wp-slate">
              Post-dev days
              <input
                type="text"
                inputMode="numeric"
                className="input mt-1 w-full"
                value={postDev}
                onChange={(e) => setPostDev(e.target.value)}
                placeholder="blank = n/a"
              />
            </label>
          </div>
          <p className="text-[11px] text-wp-slate/80">
            At least one of the three day fields must be set. Blank means the
            phase isn't sized for this example.
          </p>
          <label className="block text-xs font-medium text-wp-slate">
            Notes
            <textarea
              className="input mt-1 w-full"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder='e.g. "sized by RH, high confidence"'
            />
            <span className="mt-0.5 block text-[11px] text-wp-slate/80">
              Rendered inline in Claude's prompt as a <code>#&nbsp;Notes:</code> hint.
            </span>
          </label>
          <label className="block text-xs font-medium text-wp-slate">
            Source label
            <input
              className="input mt-1 w-full"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              placeholder='e.g. "2024 Q4 loyalty email project"'
            />
          </label>
        </div>

        {error ? (
          <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn-primary inline-flex items-center gap-2"
            disabled={saving || !title.trim()}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}
