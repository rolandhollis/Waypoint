import { useCallback, useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAiSuggestion, useCanWrite } from "../lib/queries";
import type {
  AiPhaseSuggestion,
  AiSuggestion,
  AiSuggestionFresh,
  Project,
  TshirtSize,
} from "../lib/types";
import { cn } from "../lib/cn";

/**
 * AI phase-size suggester popover for the EZEstimates view.
 *
 * Renders the sparkle button + the popover contents. The parent
 * (EZEstimatesView) supplies the T-shirt catalog and the two
 * callbacks the [Accept] buttons cascade through — `onAcceptPhase`
 * for one row, `onAcceptAll` when the user clicks the header
 * action. Both fire the SAME cascade helper the manual pickers
 * use, so audit-trail + downstream-phase shifting behave
 * identically whether the size came from a human click or Claude.
 *
 * Data flow:
 *
 *   1. Mount → `useAiSuggestion` fires a GET so a cached response
 *      shows up in the popover the moment it opens.
 *   2. Click sparkle → popover opens; if no cache exists, we
 *      immediately fire a POST to generate one. If a cache exists
 *      we DON'T auto-regenerate (spending tokens on every click
 *      would surprise the user); the [Regenerate] button inside
 *      the popover is the explicit affordance for that.
 *   3. Click [Accept …] → calls the parent's cascade helper for
 *      the matching phase; popover stays open so a PM can chain
 *      per-phase accepts.
 *   4. Click [Accept all] → sequentially fires the cascade for
 *      Discovery, Development, Post-Dev then closes the popover.
 *
 * Failure surface:
 *
 *   * 503 (not configured) → clear remediation copy telling the
 *     user that ANTHROPIC_API_KEY needs to be set as a Fly secret.
 *     No [Retry] button — retrying without the fix is pointless.
 *   * 429 (rate limit)     → error banner + [Retry] button.
 *   * 502 (upstream fail)  → error banner + [Retry] button.
 *   * Anything else        → generic error banner + [Retry].
 */

/**
 * Cascade callback contract. Fires the parent's PATCH pipeline
 * exactly like `PhaseSizePicker.onPickSize` does for the manual
 * flow, so downstream phases shift correctly and only ONE audit
 * event is written per phase pick. Returning a promise so
 * `onAcceptAll` can await each phase's optimistic transition.
 */
export type AiSuggestPhaseCascade = (
  phaseKey: "discovery" | "development" | "post_dev",
  days: number,
) => Promise<void> | void;

type AiPhaseKey = "discovery" | "development" | "post_dev";

const PHASE_ORDER: readonly AiPhaseKey[] = ["discovery", "development", "post_dev"];
const PHASE_LABEL: Record<AiPhaseKey, string> = {
  discovery: "Discovery",
  development: "Development",
  post_dev: "Post-Dev",
};

const CONFIDENCE_STYLE: Record<AiPhaseSuggestion["confidence"], string> = {
  high: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  low: "bg-slate-50 text-wp-slate border-wp-stone",
};

export function AiSuggestPopover({
  project,
  sizes,
  onAcceptPhase,
  onAcceptAll,
}: {
  project: Pick<Project, "id" | "title">;
  sizes: TshirtSize[] | undefined;
  onAcceptPhase: AiSuggestPhaseCascade;
  onAcceptAll: AiSuggestPhaseCascade;
}) {
  const canWrite = useCanWrite();
  const qc = useQueryClient();
  // Fetched lazily via `enabled: open` below so the whole
  // EZEstimates list doesn't hit the GET endpoint on mount for
  // every visible row.
  const [open, setOpen] = useState(false);
  const cached = useAiSuggestion(project.id, open);

  const generate = useMutation({
    mutationFn: () =>
      api<AiSuggestionFresh>(`/projects/${project.id}/ai-estimate`, {
        method: "POST",
      }),
    onSuccess: () => {
      // Freshen the cached-suggestion query so the next open (or
      // this open, right now) reads the new payload without a
      // second network trip.
      qc.invalidateQueries({ queryKey: ["aiSuggestion", project.id] });
    },
  });

  // Auto-generate ONLY when the popover opens against a project
  // that has never been estimated. Cached rows wait for an explicit
  // [Regenerate] click so a click doesn't silently spend a token.
  useEffect(() => {
    if (!open) return;
    if (cached.isLoading) return;
    if (cached.data?.suggestion) return;
    if (generate.isPending) return;
    if (generate.isSuccess) return;
    if (generate.isError) return;
    generate.mutate();
    // We deliberately don't depend on `generate` (mutation object
    // identity changes on every render); the guard branches above
    // handle re-entry correctly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cached.isLoading, cached.data?.suggestion]);

  const suggestion: AiSuggestion | null = useMemo(() => {
    if (generate.data?.suggestion) return generate.data.suggestion;
    return cached.data?.suggestion ?? null;
  }, [generate.data, cached.data]);

  const isShowingFresh = generate.isSuccess && !!generate.data?.suggestion;
  const generatedAt = isShowingFresh ? null : cached.data?.generated_at ?? null;

  const errMessage = useMemo(() => extractError(generate.error), [generate.error]);
  const notConfigured = errMessage?.status === 503;

  const daysFor = useCallback(
    (label: string): number | null => {
      const found = (sizes ?? []).find((s) => s.label === label);
      return found ? found.days : null;
    },
    [sizes],
  );

  async function handleAcceptAll() {
    if (!suggestion) return;
    for (const key of PHASE_ORDER) {
      const days = daysFor(suggestion[key].size);
      if (days == null) continue;
      await onAcceptAll(key, days);
    }
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Suggest phase sizes with AI"
          disabled={!canWrite}
          title={
            canWrite
              ? "Suggest phase sizes with AI"
              : "Viewer role — read-only"
          }
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-wp-stone bg-white px-2 text-xs text-wp-ink transition",
            canWrite
              ? "hover:border-wp-red/40 hover:bg-wp-red/5 hover:text-wp-red data-[state=open]:border-wp-red/40 data-[state=open]:bg-wp-red/10 data-[state=open]:text-wp-red"
              : "cursor-not-allowed opacity-50",
          )}
        >
          <Sparkles size={12} />
          <span>Suggest</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[24rem] rounded-md border border-wp-stone bg-white p-3 text-xs text-wp-ink shadow-lg outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-semibold text-wp-ink">
              <Sparkles size={13} className="text-wp-red" />
              AI phase sizing
            </div>
            {suggestion ? (
              <button
                type="button"
                className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-[11px]"
                disabled={generate.isPending || !canWrite}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RefreshCw size={11} />
                )}
                Regenerate
              </button>
            ) : null}
          </div>

          {/* Body: one of loading / error / suggestion. */}
          <div className="mt-3">
            {generate.isPending && !suggestion ? (
              <div className="flex items-center gap-2 rounded-md border border-wp-stone bg-wp-stone/20 px-3 py-4 text-wp-slate">
                <Loader2 size={13} className="animate-spin" />
                Asking Claude to size the phases…
              </div>
            ) : errMessage && !suggestion ? (
              <ErrorBanner
                status={errMessage.status}
                message={errMessage.message}
                notConfigured={notConfigured}
                canRetry={!notConfigured && canWrite}
                onRetry={() => generate.mutate()}
                retrying={generate.isPending}
              />
            ) : suggestion ? (
              <>
                {errMessage ? (
                  // Show a smaller inline warning when we DO have a stale
                  // cached answer to fall back on — the user still gets
                  // useful info while retry is available.
                  <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                    Regenerate failed ({errMessage.status}): {errMessage.message}
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  {PHASE_ORDER.map((key) => (
                    <PhaseRow
                      key={key}
                      phaseKey={key}
                      phase={suggestion[key]}
                      days={daysFor(suggestion[key].size)}
                      canWrite={canWrite}
                      onAccept={() => {
                        const d = daysFor(suggestion[key].size);
                        if (d == null) return;
                        void onAcceptPhase(key, d);
                      }}
                    />
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-1 px-2 py-1 text-[11px]"
                    disabled={!canWrite}
                    onClick={handleAcceptAll}
                  >
                    Accept all
                  </button>
                  {generatedAt ? (
                    <span className="text-[10px] text-wp-slate/70">
                      generated {formatTimeAgo(generatedAt)}
                    </span>
                  ) : (
                    <span className="text-[10px] text-wp-slate/70">
                      fresh · {suggestion.model}
                    </span>
                  )}
                </div>
              </>
            ) : cached.isLoading ? (
              <div className="rounded-md border border-wp-stone bg-wp-stone/10 px-3 py-4 text-wp-slate">
                Loading…
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-wp-stone px-3 py-4 text-wp-slate">
                No suggestion yet. Click Regenerate to ask Claude.
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PhaseRow({
  phaseKey,
  phase,
  days,
  canWrite,
  onAccept,
}: {
  phaseKey: AiPhaseKey;
  phase: AiPhaseSuggestion;
  days: number | null;
  canWrite: boolean;
  onAccept: () => void;
}) {
  const missingSize = days == null;
  return (
    <div className="rounded-md border border-wp-stone bg-white p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-wp-slate/70">
              {PHASE_LABEL[phaseKey]}
            </span>
            <span className="font-semibold text-wp-ink">
              {phase.size}
              {days != null ? (
                <span className="ml-1 font-normal text-wp-slate">
                  ({days}d)
                </span>
              ) : (
                <span className="ml-1 text-[10px] font-normal text-amber-700">
                  (label not in catalog)
                </span>
              )}
            </span>
            <ConfidenceBadge value={phase.confidence} />
          </div>
          <div
            className="mt-1 line-clamp-2 text-[11px] leading-snug text-wp-slate"
            title={phase.reasoning}
          >
            {phase.reasoning}
          </div>
        </div>
        <button
          type="button"
          onClick={onAccept}
          disabled={!canWrite || missingSize}
          className={cn(
            "shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium transition",
            canWrite && !missingSize
              ? "border-wp-red/40 bg-wp-red/5 text-wp-red hover:bg-wp-red/10"
              : "cursor-not-allowed border-wp-stone bg-wp-stone/20 text-wp-slate/70",
          )}
          title={
            missingSize
              ? "This size label is no longer in the T-shirt catalog"
              : `Set ${PHASE_LABEL[phaseKey]} to ${phase.size} (${days}d) — cascades to later phases`
          }
        >
          Accept
        </button>
      </div>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: AiPhaseSuggestion["confidence"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 text-[9px] font-medium uppercase tracking-wide",
        CONFIDENCE_STYLE[value],
      )}
    >
      {value}
    </span>
  );
}

function ErrorBanner({
  status,
  message,
  notConfigured,
  canRetry,
  onRetry,
  retrying,
}: {
  status: number;
  message: string;
  notConfigured: boolean;
  canRetry: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
      <div className="text-[11px] font-semibold uppercase tracking-wide">
        {notConfigured ? "Not configured" : `Error ${status}`}
      </div>
      <p className="mt-1 text-[11px] leading-snug">{message}</p>
      {canRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-2 inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
        >
          {retrying ? <Loader2 size={11} className="animate-spin" /> : null}
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Lightweight rel-time formatter — good enough for a popover
 *  footer and avoids pulling in date-fns just for this. */
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

type ExtractedError = { status: number; message: string } | null;

function extractError(err: unknown): ExtractedError {
  if (!err) return null;
  if (err instanceof ApiError) {
    return { status: err.status, message: err.message };
  }
  if (err instanceof Error) {
    return { status: 0, message: err.message };
  }
  return { status: 0, message: "Unknown error" };
}
