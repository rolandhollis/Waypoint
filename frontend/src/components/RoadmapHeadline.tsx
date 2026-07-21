import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useMe } from "../lib/queries";
import type {
  AiHeadlineGroupPayload,
  AiHeadlineRequestBody,
  AiHeadlineResponse,
} from "../lib/types";
import {
  computeHeadlineFingerprint,
  timeframeLabelFor,
  toWireGroupBy,
} from "../lib/roadmapHeadline";
import { useViewStore, type FilterState, type GroupBy } from "../lib/viewState";
import { cn } from "../lib/cn";
import { Collapsible } from "./Collapsible";

/**
 * "Headline summary" panel at the bottom of the Roadmap view.
 * Wraps the existing Collapsible so the section slides open with
 * the same animation the Recent Changes / Unscheduled panels use.
 *
 * Data flow:
 *
 *   1. RoadmapView pre-computes the same inputs the Gantt sees
 *      (filters + zoom + groupBy + the id set of scheduled +
 *      in-viewport projects) and passes them here.
 *   2. This component derives a SHA-256 fingerprint over those
 *      inputs and looks up the cached headline (keyed by tenant)
 *      in the zustand `roadmapHeadline` slice.
 *   3. If a cached entry exists AND its fingerprint matches, we
 *      render the headline + a "Regenerate" link + a
 *      "Generated <time-ago>" footer.
 *   4. If a cached entry exists but the fingerprint differs, we
 *      render a small amber "Filters changed since this summary
 *      was generated" notice above the stale headline so the user
 *      can still read it while deciding whether to refresh.
 *   5. If no cache exists, we render a call-to-action button
 *      ("Generate headline"). Explicit user click ONLY — we don't
 *      auto-fire on first expand.
 *
 * Nothing about the report is persisted server-side; the endpoint
 * is stateless and every regenerate incurs a fresh Claude call.
 */
export function RoadmapHeadline({
  filters,
  groupBy,
  zoom,
  visibleProjectIds,
  groups,
}: {
  filters: FilterState;
  groupBy: GroupBy;
  zoom: "3mo" | "6mo" | "1yr" | "all";
  /**
   * Ordered array of the scheduled project ids currently in the
   * Gantt viewport. Order is preserved from the caller so the
   * fingerprint stays consistent turn-to-turn without a second
   * sort here.
   */
  visibleProjectIds: string[];
  /**
   * Pre-grouped payload the endpoint expects. RoadmapView owns
   * the grouping so the same team / owner / KPI resolution used
   * elsewhere on the view drives the summary too — this component
   * doesn't rebuild the buckets or resolve names on its own.
   */
  groups: AiHeadlineGroupPayload[];
}) {
  const me = useMe();
  const currentGroupId = me.data?.current_group_id ?? null;

  const [sectionOpen, setSectionOpen] = useState(false);

  const cache = useViewStore((s) => s.roadmapHeadline.byGroupId);
  const setRoadmapHeadline = useViewStore((s) => s.setRoadmapHeadline);
  const cached = currentGroupId ? cache[currentGroupId] : undefined;

  // Fingerprint is derived asynchronously (crypto.subtle.digest
  // returns a Promise). Track the current value in state so the
  // "cache matches?" comparison stays reactive without blocking
  // render. Recomputes whenever the caller-passed inputs change.
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    computeHeadlineFingerprint({
      groupBy,
      zoom,
      filters,
      visibleProjectIds,
    }).then((fp) => {
      if (!cancelled) setFingerprint(fp);
    }).catch(() => {
      if (!cancelled) setFingerprint(null);
    });
    return () => { cancelled = true; };
  }, [groupBy, zoom, filters, visibleProjectIds]);

  const fingerprintMatches = !!cached && !!fingerprint && cached.fingerprint === fingerprint;

  const generate = useMutation({
    mutationFn: async (): Promise<AiHeadlineResponse> => {
      if (!fingerprint) {
        throw new Error("fingerprint not yet computed");
      }
      const body: AiHeadlineRequestBody = {
        fingerprint,
        groupBy: toWireGroupBy(groupBy),
        timeframeLabel: timeframeLabelFor(zoom),
        groups,
      };
      return api<AiHeadlineResponse>("/ai/roadmap-headline", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (res) => {
      if (!currentGroupId) return;
      setRoadmapHeadline(currentGroupId, {
        fingerprint: res.fingerprint,
        headline: res.headline,
        model: res.model,
        generatedAt: res.generatedAt,
      });
    },
  });

  const errMessage = useMemo(() => extractError(generate.error), [generate.error]);
  const notConfigured = errMessage?.status === 503;

  const canGenerate = !!fingerprint && !generate.isPending;
  // Only offer the CTA when there's actually something to
  // summarize. Zero groups = the roadmap is empty for this filter
  // slice, so a headline would be a single "no items" sentence at
  // best. Hide the button rather than let the user spend a token
  // on that.
  const hasContent = groups.length > 0 && groups.some((g) => g.projects.length > 0);

  const totalItems = groups.reduce((n, g) => n + g.projects.length, 0);

  return (
    <section className="border-t border-wp-stone bg-wp-bg/60 px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setSectionOpen(!sectionOpen)}
        aria-expanded={sectionOpen}
      >
          <ChevronRight
          size={14}
          className={cn(
            "text-wp-slate transition-transform duration-200 ease-out motion-reduce:transition-none",
            sectionOpen && "rotate-90",
          )}
        />
        <Sparkles size={14} className="text-wp-red" />
        <h3 className="text-sm font-semibold text-wp-ink">Headline summary</h3>
        <span className="text-xs text-wp-slate">
            {sectionOpen ? (
            cached ? (
              fingerprintMatches
                ? "— Latest matches the current view"
                : "— Filters have changed since the last summary"
            ) : (
              "— Ask Claude to summarize what's coming up in the current view."
            )
          ) : (
            "— Ask Claude to summarize what's coming up in the current view."
            )}
        </span>
      </button>

      <Collapsible open={sectionOpen}>
        <div className="mt-3 space-y-2">
          {/* Fingerprint-changed banner. Shown above (not in place
              of) the stale headline so the user can still read the
              previous summary while choosing whether to refresh. */}
          {cached && !fingerprintMatches ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-600" />
              <div className="flex-1">
                Filters changed since this summary was generated.
                {" "}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2 hover:text-amber-950 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!canGenerate || !hasContent}
                  onClick={() => generate.mutate()}
                  >
                  Regenerate
                </button>
              </div>
            </div>
          ) : null}

          {/* Error / not-configured banner. Errors from a
              regenerate attempt sit above whatever cached headline
              we have so the user still sees the last-good copy. */}
            {errMessage ? (
            <HeadlineErrorBanner
              status={errMessage.status}
              message={errMessage.message}
              notConfigured={notConfigured}
              canRetry={!notConfigured && canGenerate && hasContent}
              retrying={generate.isPending}
              onRetry={() => generate.mutate()}
            />
          ) : null}

          {/* Main content. The three states are: (1) generating
              for the first time, (2) have a headline (cached OR
              fresh) to show, (3) empty — user hasn't asked yet. */}
          {generate.isPending && !cached ? (
            <div className="flex items-center gap-2 rounded-md border border-wp-stone bg-wp-stone/20 px-3 py-4 text-xs text-wp-slate">
              <Loader2 size={13} className="animate-spin" />
              Asking Claude to write the headline summary…
            </div>
          ) : cached ? (
              <div className="rounded-md border border-wp-stone bg-white p-3">
              <HeadlineMarkdown text={cached.headline} />
              <div className="mt-3 flex items-center justify-between border-t border-wp-stone/60 pt-2 text-[11px] text-wp-slate/80">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 font-medium text-wp-slate hover:text-wp-ink disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!canGenerate || !hasContent}
                  onClick={() => generate.mutate()}
                >
                  {generate.isPending ? (
                   <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  Regenerate
                </button>
                <span>
                  Generated {formatTimeAgo(cached.generatedAt)} · {cached.model}
                </span>
              </div>
              </div>
          ) : (
            <div className="rounded-md border border-dashed border-wp-stone bg-white p-3 text-xs text-wp-slate">
              <p>
                {hasContent
                  ? `Summarize the ${totalItems} project${totalItems === 1 ? "" : "s"} currently visible in this view, grouped by ${groupingCopy(groupBy)}. Two to four sentences per section, executive tone.`
                  : "Nothing to summarize — the current filters leave the roadmap empty. Widen the filters or timeframe first."}
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-1.5 !py-1 !text-xs"
                  disabled={!canGenerate || !hasContent}
                  onClick={() => generate.mutate()}
                >
                  {generate.isPending ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  Generate headline
                </button>
              </div>
            </div>
          )}
        </div>
      </Collapsible>
    </section>
  );
}

/**
 * User-friendly phrasing for the axis label used in the CTA copy.
 * Only appears in the empty state — the generated headline itself
 * uses whatever grouping labels the server picked up from the
 * payload.
 */
function groupingCopy(groupBy: GroupBy): string {
  switch (groupBy) {
    case "team": return "team";
    case "owner": return "owner";
    case "swim_lane": return "swim lane";
    case "kpi": return "KPI";
    case "tag": return "tag";
    case "none":
    default:
      return "the current lane order";
  }
}

/**
 * Lightweight markdown-lite renderer for the headline text.
 * Splits on `## ` group headers and renders each block as a
 * heading + paragraphs. No dependency on a full markdown parser —
 * the endpoint's prompt guarantees the output stays inside this
 * tiny grammar (headers + prose paragraphs).
 *
 * Handles two malformed-but-plausible cases defensively:
 *   * Prose before the first header (rendered as an intro para).
 *   * Missing headers entirely (renders as one prose block).
 */
function HeadlineMarkdown({ text }: { text: string }) {
  const sections = useMemo(() => splitByHeaders(text), [text]);
  return (
    <div className="space-y-3 text-sm text-wp-ink">
      {sections.map((s, i) => (
        <div key={i}>
          {s.heading ? (
            <h4 className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
              {s.heading}
            </h4>
          ) : null}
          {s.paragraphs.map((p, j) => (
            <p key={j} className="mt-1 whitespace-pre-line leading-relaxed">
              {p}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

type HeadlineSection = { heading: string | null; paragraphs: string[] };

function splitByHeaders(text: string): HeadlineSection[] {
  const lines = text.split(/\r?\n/);
  const sections: HeadlineSection[] = [];
  let current: HeadlineSection = { heading: null, paragraphs: [] };
  let buffer: string[] = [];

  const flushParagraph = () => {
    const joined = buffer.join("\n").trim();
    if (joined) current.paragraphs.push(joined);
    buffer = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (current.heading !== null || current.paragraphs.length > 0) {
      sections.push(current);
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const headerMatch = /^##\s+(.+)/.exec(line);
    if (headerMatch) {
      flushSection();
      current = { heading: headerMatch[1]!.trim(), paragraphs: [] };
      buffer = [];
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    buffer.push(line);
  }
  flushSection();

  return sections.length ? sections : [{ heading: null, paragraphs: [text.trim()] }];
}

function HeadlineErrorBanner({
  status,
  message,
  notConfigured,
  canRetry,
  retrying,
  onRetry,
}: {
  status: number;
  message: string;
  notConfigured: boolean;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
      <div className="text-[11px] font-semibold uppercase tracking-wide">
       {notConfigured ? "Not configured" : `Error ${status || ""}`.trim()}
      </div>
      <p className="mt-1 leading-snug">{message}</p>
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
