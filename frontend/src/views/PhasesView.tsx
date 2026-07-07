import { useSwimLanes } from "../lib/queries";

/**
 * Reference page listing every swim lane (i.e. every phase in the
 * workflow) alongside its admin-authored description. Intended as a
 * quick "what does this column mean?" lookup for anyone new to the
 * board, and as the canonical view of lane copy when we start
 * onboarding people async.
 */
export function PhasesView() {
  const lanes = useSwimLanes();

  if (lanes.isLoading) {
    return <div className="p-6 text-sm text-wp-slate">Loading phases…</div>;
  }

  const data = lanes.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-wp-ink">Workflow phases</h1>
        <p className="mt-1 text-sm text-wp-slate">
          Every card on the board sits in exactly one phase. This page is the source
          of truth for what each phase means. Admins can edit the descriptions in
          <span className="whitespace-nowrap"> Admin Settings → Swim lanes</span>.
        </p>
      </header>

      {data.length === 0 ? (
        <p className="text-sm text-wp-slate">No phases defined yet.</p>
      ) : (
        <ol className="space-y-3">
          {data.map((lane, i) => {
            const description = lane.description?.trim() ?? "";
            return (
              <li key={lane.id} className="card-surface p-4">
                <div className="flex items-baseline gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wide text-wp-slate/70">
                    Phase {i + 1}
                  </span>
                  <div className="flex flex-1 items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ background: lane.color ?? "#94a3b8" }}
                      aria-hidden
                    />
                    <h2 className="text-base font-semibold text-wp-ink">{lane.name}</h2>
                    {lane.requires_weekly_status ? (
                      <span className="chip !border-amber-300 !bg-amber-50 !text-amber-800">
                        weekly status
                      </span>
                    ) : null}
                    {lane.is_terminal ? (
                      <span className="chip !border-emerald-300 !bg-emerald-50 !text-emerald-800">
                        terminal
                      </span>
                    ) : null}
                  </div>
                </div>
                <p
                  className={`mt-2 whitespace-pre-line text-sm ${description ? "text-wp-ink/85" : "italic text-wp-slate"}`}
                >
                  {description || "No description yet. Ask an admin to fill this in."}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
