import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { MutationErrorBanner } from "../components/MutationErrorBanner";
import { ViewPageHeader } from "../components/ViewPageHeader";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  useIsAdmin,
  usePredictionGameHistory,
  usePredictionGameToday,
  useCurrentGroup,
} from "../lib/queries";
import type { PredictionTodayResponse } from "../lib/types";

function formatCentralTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function VoteTally({
  counts,
  highlight,
}: {
  counts: { will_happen: number; will_not_happen: number };
  highlight?: boolean | null;
}) {
  const total = counts.will_happen + counts.will_not_happen;
  const yesPct = total ? Math.round((counts.will_happen / total) * 100) : 0;
  const noPct = total ? 100 - yesPct : 0;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-wp-slate">
        <span className={cn(highlight === true && "font-semibold text-wp-ink")}>
          Will happen · {counts.will_happen} ({yesPct}%)
        </span>
        <span className={cn(highlight === false && "font-semibold text-wp-ink")}>
          Won&apos;t happen · {counts.will_not_happen} ({noPct}%)
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-wp-stone/50">
        <div
          className="bg-emerald-500 transition-all"
          style={{ width: `${yesPct}%` }}
        />
        <div
          className="bg-wp-slate/40 transition-all"
          style={{ width: `${noPct}%` }}
        />
      </div>
      <p className="text-[11px] text-wp-slate">{total} vote{total === 1 ? "" : "s"}</p>
    </div>
  );
}

export function GameView() {
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const currentGroup = useCurrentGroup();
  const regenerateEnabled =
    currentGroup?.constants?.prediction_game_regenerate_enabled === true;
  const today = usePredictionGameToday();
  const history = usePredictionGameHistory();
  const [resolveNote, setResolveNote] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["predictionGameToday"] });
    qc.invalidateQueries({ queryKey: ["predictionGameHistory"] });
  };

  const vote = useMutation({
    mutationFn: (prediction: boolean) =>
      api<PredictionTodayResponse>("/prediction-game/today/vote", {
        method: "POST",
        body: JSON.stringify({ prediction }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["predictionGameToday"], data);
    },
  });

  const generate = useMutation({
    mutationFn: () =>
      api<PredictionTodayResponse>("/prediction-game/generate", { method: "POST" }),
    onSuccess: (data) => {
      qc.setQueryData(["predictionGameToday"], data);
      invalidate();
    },
  });

  const resolve = useMutation({
    mutationFn: (args: { id: string; outcome: boolean }) =>
      api(`/prediction-game/${args.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          outcome: args.outcome,
          note: resolveNote.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      setResolveNote("");
      invalidate();
    },
  });

  const data = today.data;
  const question = data?.question;
  const votingOpen = data?.voting_open ?? false;
  const votingBeforeOpen =
    !votingOpen &&
    data?.opens_at != null &&
    Date.now() < new Date(data.opens_at).getTime();
  const myVote = data?.my_vote?.prediction;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ViewPageHeader tabKey="game" />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-6">
          <MutationErrorBanner mutation={vote} />
          <MutationErrorBanner mutation={generate} />
          <MutationErrorBanner mutation={resolve} />

          {today.isLoading ? (
            <p className="text-sm text-wp-slate">Loading today&apos;s question…</p>
          ) : !question ? (
            <div className="card-surface space-y-3 p-5">
              <p className="text-sm text-wp-slate">
                No question has been published for today yet. A new one is generated
                automatically each morning
                {isAdmin && regenerateEnabled
                  ? ", or you can create one now."
                  : "."}
              </p>
              {isAdmin && regenerateEnabled ? (
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-1.5"
                  disabled={generate.isPending}
                  onClick={() => generate.mutate()}
                >
                  <Sparkles size={14} />
                  {generate.isPending ? "Generating…" : "Generate today's question"}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="card-surface space-y-5 p-5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-wp-slate">
                <span className="inline-flex items-center gap-1 rounded-full bg-wp-stone/40 px-2 py-0.5">
                  <Clock size={12} />
                  Voting{" "}
                  {data?.opens_at ? formatCentralTime(data.opens_at) : "9:00am CT"}
                  {" – "}
                  {data?.cutoff_at ? formatCentralTime(data.cutoff_at) : "5:00pm CT"}
                </span>
                {question.event_time_hint ? (
                  <span className="rounded-full bg-wp-stone/30 px-2 py-0.5">
                    Event ~ {question.event_time_hint}
                  </span>
                ) : null}
                {question.kalshi_market_ticker ? (
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-violet-900">
                    Kalshi ~{question.kalshi_yes_price != null ? `${Math.round(question.kalshi_yes_price * 100)}%` : "50%"}
                  </span>
                ) : null}
                {votingOpen ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
                    Voting open
                  </span>
                ) : votingBeforeOpen ? (
                  <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-900">
                    Opens soon
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
                    Voting closed
                  </span>
                )}
              </div>

              <p className="text-lg font-semibold leading-snug text-wp-ink">
                {question.question_text}
              </p>

              {votingOpen ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    className={cn(
                      "rounded-lg border-2 px-4 py-3 text-left transition",
                      myVote === true
                        ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                        : "border-wp-stone hover:border-emerald-300 hover:bg-emerald-50/50",
                    )}
                    disabled={vote.isPending}
                    onClick={() => vote.mutate(true)}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <Check size={16} />
                      Will happen
                    </span>
                    <span className="mt-1 block text-xs text-wp-slate">
                      {question.vote_yes_hint ?? "Happens as scheduled tonight."}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-lg border-2 px-4 py-3 text-left transition",
                      myVote === false
                        ? "border-wp-slate bg-wp-stone/30 text-wp-ink"
                        : "border-wp-stone hover:border-wp-slate/60 hover:bg-wp-stone/20",
                    )}
                    disabled={vote.isPending}
                    onClick={() => vote.mutate(false)}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <X size={16} />
                      Won&apos;t happen
                    </span>
                    <span className="mt-1 block text-xs text-wp-slate">
                      {question.vote_no_hint ?? "Does not happen that way tonight."}
                    </span>
                  </button>
                </div>
              ) : null}

              {data?.vote_counts ? (
                <VoteTally counts={data.vote_counts} highlight={myVote} />
              ) : null}

              {question.outcome !== null ? (
                <div
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm",
                    question.outcome
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-wp-stone bg-wp-stone/20 text-wp-ink",
                  )}
                >
                  <span className="font-semibold">Result: </span>
                  {question.outcome ? "Happened" : "Did not happen"}
                  {question.outcome_note ? (
                    <span className="text-wp-slate"> — {question.outcome_note}</span>
                  ) : null}
                </div>
              ) : null}

              {isAdmin && !votingOpen && question.outcome === null ? (
                <div className="space-y-3 rounded-md border border-wp-stone bg-wp-stone/10 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
                    Admin — record outcome
                  </p>
                  <textarea
                    className="input min-h-[3rem] text-sm"
                    placeholder="Optional note for the team"
                    value={resolveNote}
                    onChange={(e) => setResolveNote(e.target.value)}
                    maxLength={2000}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ id: question.id, outcome: true })}
                    >
                      Mark happened
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ id: question.id, outcome: false })}
                    >
                      Mark did not happen
                    </button>
                    {regenerateEnabled ? (
                      <button
                        type="button"
                        className="btn-secondary inline-flex items-center gap-1.5"
                        disabled={generate.isPending}
                        onClick={() => generate.mutate()}
                      >
                        <Sparkles size={14} />
                        Regenerate question
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : isAdmin && votingOpen && regenerateEnabled ? (
                <button
                  type="button"
                  className="btn-secondary inline-flex items-center gap-1.5 text-sm"
                  disabled={generate.isPending}
                  onClick={() => generate.mutate()}
                >
                  <Sparkles size={14} />
                  Regenerate question
                </button>
              ) : null}
            </div>
          )}

          {history.data && history.data.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-wp-ink">Recent days</h2>
              <ul className="space-y-2">
                {history.data
                  .filter((row) => row.id !== question?.id)
                  .slice(0, 7)
                  .map((row) => (
                    <li
                      key={row.id}
                      className="rounded-md border border-wp-stone bg-white px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs text-wp-slate">{row.game_date}</span>
                        {row.outcome !== null ? (
                          <span className="text-xs font-medium text-wp-ink">
                            {row.outcome ? "Happened" : "Did not happen"}
                          </span>
                        ) : (
                          <span className="text-xs text-wp-slate">Pending</span>
                        )}
                      </div>
                      <p className="mt-1 text-wp-ink">{row.question_text}</p>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
