import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useCanWrite, useMe } from "../lib/queries";
import { computeHeadlineFingerprint } from "../lib/roadmapHeadline";
import type { FilterState, GroupBy } from "../lib/viewState";
import { cn } from "../lib/cn";

/**
 * Overview text at the top of the Roadmap view.
 *
 * The row is scoped by the caller's active group AND by the same
 * per-view fingerprint the AI Roadmap Headline uses (filters +
 * timeframe + group-by + visible-project ids — see
 * `computeHeadlineFingerprint`), so switching filters lands the
 * user on a different overview and a returning viewer sees the
 * exact same one their teammate authored.
 *
 * Three visual states:
 *   1. Empty — no row saved yet: subtle dashed "Add overview" ghost
 *      button (edit-role users only) or nothing at all (viewers).
 *   2. Populated — saved text with an edit pencil in the top-right
 *      and an "Updated by X · N ago" footer.
 *   3. Editing — autosizing <textarea> with Save / Cancel buttons.
 *      cmd/ctrl+enter also saves.
 *
 * Persistence is server-side (see backend/src/routes/roadmapOverviews.ts);
 * this component is a thin editor over the GET/PUT endpoints. React
 * Query holds the cache; PUT invalidates on success.
 *
 * Rendering is deliberately markdown-lite: whitespace-pre-wrap only,
 * so newlines survive but no `**bold**` / `# heading` / link parsing
 * runs. That matches the spec ("no need for a rich editor") and
 * keeps the bundle free of a markdown dep.
 */
export function RoadmapOverview({
  filters,
  groupBy,
  zoom,
  visibleProjectIds,
  pdfMode = false,
}: {
  filters: FilterState;
  groupBy: GroupBy;
  zoom: "3mo" | "6mo" | "1yr" | "all";
  /**
   * Ordered array of the scheduled project ids currently in the
   * Gantt viewport. Same list RoadmapHeadline consumes so the two
   * features' fingerprints line up perfectly and one overview
   * corresponds to one AI-generated summary.
   */
  visibleProjectIds: string[];
  /**
   * When true, the populated read-only body renders at its full,
   * uncapped height with no scrollbar so the PDF exporter can
   * snapshot every line. In normal (non-export) rendering the body
   * is capped to ~6 lines and scrolls internally to keep the
   * roadmap page compact.
   */
  pdfMode?: boolean;
}) {
  const me = useMe();
  const canWrite = useCanWrite();
  const currentGroupId = me.data?.current_group_id ?? null;
  const qc = useQueryClient();

  // Fingerprint is derived asynchronously (crypto.subtle.digest
  // returns a Promise). Track it in state so the react-query key
  // stays reactive. Recomputes whenever the caller-passed inputs
  // change; identical to the pattern used inside RoadmapHeadline.
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    computeHeadlineFingerprint({ groupBy, zoom, filters, visibleProjectIds })
      .then((fp) => { if (!cancelled) setFingerprint(fp); })
      .catch(() => { if (!cancelled) setFingerprint(null); });
    return () => { cancelled = true; };
  }, [groupBy, zoom, filters, visibleProjectIds]);

  const queryKey = ["roadmap-overview", currentGroupId, fingerprint] as const;

  const overview = useQuery({
    queryKey,
    queryFn: () => api<OverviewResponse>(`/roadmap-overviews/${fingerprint}`),
    // Only fire once both the current group AND fingerprint are
    // resolved; before that the URL would carry a literal "null"
    // segment. React Query keeps returning `data: undefined` in
    // the meantime, which the render tree maps to the empty state
    // (which is fine — same as "no overview saved yet").
    enabled: !!currentGroupId && !!fingerprint,
    staleTime: 30_000,
    retry: false,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const persisted = overview.data?.body ?? "";
  const hasPersisted = persisted.trim().length > 0;

  const enterEdit = () => {
    setDraft(persisted);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft("");
  };

  const save = useMutation({
    mutationFn: async (): Promise<OverviewResponse> => {
      if (!fingerprint) throw new Error("fingerprint not yet computed");
      return api<OverviewResponse>(`/roadmap-overviews/${fingerprint}`, {
        method: "PUT",
        body: JSON.stringify({ body: draft }),
      });
    },
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data);
      setEditing(false);
      setDraft("");
    },
  });

  // Autosize the textarea to fit content. Runs synchronously
  // before paint so the box doesn't flash a one-line height on
  // first render into edit mode with pre-existing text.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 480)}px`;
  }, [editing, draft]);

  // Focus on entering edit mode, and put the caret at the end so
  // an existing overview is easy to append to.
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [editing]);

  const errorMessage = useMemo(() => extractError(save.error), [save.error]);

  // Guard: hitting Save with an empty draft and nothing already
  // persisted would be a no-op on the server (empty body → row
  // stays absent). Block the click so the button doesn't feel
  // unresponsive. An empty draft WITH an existing overview stays
  // valid — that's the "clear this out" flow (deletes the row).
  const saveDisabled =
    save.isPending || !fingerprint || (draft.trim() === "" && !hasPersisted);

  // Loading is only "loading" the very first time we fetch for
  // this (group, fingerprint) pair. React Query keeps the last
  // resolved data around while refetching, so filter changes
  // don't blank the panel — they just repaint once the new row
  // resolves.
  const isFirstLoad = overview.isLoading && overview.data === undefined;

  // Viewers with no saved overview see nothing at all. Rendering
  // an empty ghost slot they can't act on would just add clutter
  // to their read-only view.
  const showEmptyGhost = !editing && !hasPersisted && canWrite;
  const showViewerBlank = !editing && !hasPersisted && !canWrite;

  if (showViewerBlank) return null;

  return (
    <section className="border-b border-wp-stone bg-wp-bg/60 px-4 py-3">
      {isFirstLoad ? (
        <div className="flex min-h-[48px] items-center gap-2 rounded-md border border-wp-stone/60 bg-white/40 px-3 py-2 text-xs text-wp-slate">
          <Loader2 size={12} className="animate-spin" />
          Loading overview…
        </div>
      ) : editing ? (
        <div className="rounded-md border border-wp-stone bg-white p-3 shadow-sm">
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-wp-slate">
            Roadmap overview
          </label>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // cmd/ctrl+enter saves. Escape cancels. Both match
              // the ProjectDetailPanel comment editor so muscle
              // memory carries over.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (!saveDisabled) save.mutate();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            placeholder="Give this roadmap slice a short overview — what's the theme, what's changing, what should readers pay attention to?"
            maxLength={20_000}
            className={cn(
              "mt-1 block w-full resize-none rounded-md border border-wp-stone bg-white px-2.5 py-1.5 text-sm text-wp-ink outline-none placeholder:text-wp-slate/60 focus:border-wp-red focus:ring-1 focus:ring-wp-red",
            )}
            rows={3}
          />
          {errorMessage ? (
            <p className="mt-2 text-xs text-red-700">{errorMessage}</p>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-wp-slate/80">
              Overview is saved for the current filters + timeframe.
              Everyone in the group sees it when they load the same view.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                className="btn-secondary !py-1 !text-xs"
                disabled={save.isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => save.mutate()}
                disabled={saveDisabled}
                className="btn-primary !py-1 !text-xs"
              >
                {save.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : null}
                Save
              </button>
            </div>
          </div>
        </div>
      ) : hasPersisted ? (
        <div className="group relative rounded-md border border-wp-stone bg-white px-3 py-2.5 shadow-sm">
          {canWrite ? (
            <button
              type="button"
              onClick={enterEdit}
              aria-label="Edit overview"
              title="Edit overview"
              className="absolute right-2 top-2 rounded p-1 text-wp-slate opacity-60 transition hover:bg-wp-stone/40 hover:text-wp-ink hover:opacity-100"
            >
              <Pencil size={13} />
            </button>
          ) : null}
          {/* Cap the read-only body to ~6 lines with an internal
              scroll so a long overview doesn't push the Gantt
              timeline off the initial viewport. In PDF export mode
              (`pdfMode=true`) the cap and overflow are dropped so
              html-to-image can capture the full body — the
              exporter flushSync's the pdfMode flip before snapshot,
              so the fully-expanded DOM is guaranteed to be present
              at capture time. Height is expressed in `em` so it
              tracks the text-sm/leading-relaxed line-height without
              a magic pixel constant. */}
          <div
            className={cn(
              "whitespace-pre-wrap pr-8 text-sm leading-relaxed text-wp-ink",
              !pdfMode && "max-h-[calc(1.625em*6)] overflow-y-auto",
            )}
          >
            {persisted}
          </div>
          <div className="mt-2 border-t border-wp-stone/60 pt-2 text-[11px] text-wp-slate/80">
            {formatUpdatedFooter(overview.data)}
          </div>
        </div>
      ) : showEmptyGhost ? (
        <button
          type="button"
          onClick={enterEdit}
          className="flex min-h-[48px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-wp-stone bg-white/40 px-3 py-2 text-xs text-wp-slate transition hover:border-wp-slate/50 hover:bg-white hover:text-wp-ink"
        >
          <Plus size={12} />
          Add overview for the current filters
        </button>
      ) : null}
    </section>
  );
}

type OverviewResponse = {
  body: string;
  updated_at: string | null;
  updated_by_name: string | null;
};

function formatUpdatedFooter(data: OverviewResponse | undefined): string {
  if (!data || !data.updated_at) return "";
  const who = data.updated_by_name?.trim() || "someone";
  return `Updated by ${who} · ${formatTimeAgo(data.updated_at)}`;
}

function formatTimeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function extractError(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}
