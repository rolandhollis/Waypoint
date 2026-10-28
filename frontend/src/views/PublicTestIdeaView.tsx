import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, FlaskConical, Loader2 } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { pillTextColor } from "../lib/colors";

type PublicTeam = {
  id: string;
  name: string;
  color: string | null;
  order: number;
};

type PublicTestIdeaMeta = {
  group_id: string;
  group_name: string;
  public_slug: string | null;
  share_path: string;
  share_url: string;
  teams: PublicTeam[];
};

type CreatedTestIdea = {
  id: string;
  title: string;
  group_id: string;
};

type Step = "welcome" | "form" | "success";

/**
 * Public, unauthenticated A/B test idea intake — three steps:
 *   1. Welcome + CTA
 *   2. Form (title, description, optional team, submitter contact)
 *   3. Success confirmation
 *
 * Shareable at `/test-ideas/<slug>` (UUID still works). Creates a
 * card in the A/B Testing "Backlog (ideas)" lane and emails workspace
 * admins with a deep link to `/ab-testing?item=:id`.
 */
export function PublicTestIdeaView() {
  const { slugOrId = "" } = useParams<{ slugOrId: string }>();
  const [step, setStep] = useState<Step>("welcome");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [submitterName, setSubmitterName] = useState("");
  const [submitterEmail, setSubmitterEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedTestIdea | null>(null);

  const meta = useQuery({
    queryKey: ["public-test-idea-meta", slugOrId],
    queryFn: () => api<PublicTestIdeaMeta>(`/public/test-ideas/${slugOrId}`),
    enabled: !!slugOrId,
    retry: false,
  });

  const submit = useMutation({
    mutationFn: () =>
      api<CreatedTestIdea>(`/public/test-ideas/${slugOrId}`, {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          team_id: teamId,
          submitter_name: submitterName.trim(),
          submitter_email: submitterEmail.trim(),
        }),
      }),
    onSuccess: (row) => {
      setCreated(row);
      setStep("success");
      setError(null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many submissions from this email. Try again in a few minutes.");
        return;
      }
      if (err instanceof ApiError) {
        setError(err.message || "We couldn't submit that test idea. Try again.");
        return;
      }
      setError("We couldn't submit that test idea. Try again in a moment.");
    },
  });

  const canSubmit = useMemo(
    () =>
      title.trim().length > 0 &&
      submitterName.trim().length > 0 &&
      submitterEmail.trim().length > 0 &&
      !submit.isPending,
    [title, submitterName, submitterEmail, submit.isPending],
  );

  if (!slugOrId) {
    return (
      <Shell>
        <p className="text-sm text-wp-slate">This test idea form link is missing a workspace.</p>
      </Shell>
    );
  }

  if (meta.isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-wp-slate">
          <Loader2 size={16} className="animate-spin" />
          Loading form…
        </div>
      </Shell>
    );
  }

  if (meta.isError || !meta.data) {
    return (
      <Shell>
        <p className="text-sm text-wp-slate">
          We couldn't find that workspace. Check the link with your PM, or{" "}
          <Link to="/login" className="font-medium text-wp-ink underline">
            sign in
          </Link>
          .
        </p>
      </Shell>
    );
  }

  const workspace = meta.data;

  return (
    <Shell groupName={workspace.group_name}>
      {step === "welcome" ? (
        <WelcomeStep
          groupName={workspace.group_name}
          onContinue={() => setStep("form")}
        />
      ) : null}

      {step === "form" ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            setError(null);
            submit.mutate();
          }}
        >
          <div>
            <h1 className="text-lg font-semibold text-wp-ink">Submit a test idea</h1>
            <p className="mt-1 text-sm text-wp-slate">
              Pitch an experiment for the{" "}
              <strong className="font-medium text-wp-ink">{workspace.group_name}</strong>{" "}
              A/B Testing backlog. Product managers will be notified when you submit.
            </p>
          </div>

          {error ? (
            <div
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <label className="block text-xs font-medium text-wp-slate">
            Title <span className="text-wp-red">*</span>
            <input
              className="input mt-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
              placeholder="Short name for the experiment"
              required
            />
          </label>

          <label className="block text-xs font-medium text-wp-slate">
            Description <span className="text-wp-slate/70">(optional)</span>
            <textarea
              className="input mt-1 min-h-[8rem]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={10_000}
              placeholder="What hypothesis are you testing? Who’s the audience? Any success metrics or links help."
            />
          </label>

          {workspace.teams.length > 0 ? (
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-wp-slate">
                Team <span className="text-wp-slate/70">(optional)</span>
              </legend>
              <div className="flex flex-wrap gap-2">
                {workspace.teams.map((t) => {
                  const selected = teamId === t.id;
                  const bg = t.color || "#94a3b8";
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setTeamId(selected ? null : t.id)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                        selected
                          ? "border-transparent shadow-sm"
                          : "border-wp-stone bg-white text-wp-ink hover:border-wp-slate/40",
                      )}
                      style={
                        selected
                          ? { background: bg, color: pillTextColor(bg) }
                          : undefined
                      }
                    >
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-wp-slate">
              Your name <span className="text-wp-red">*</span>
              <input
                className="input mt-1"
                value={submitterName}
                onChange={(e) => setSubmitterName(e.target.value)}
                maxLength={120}
                autoComplete="name"
                required
              />
            </label>
            <label className="block text-xs font-medium text-wp-slate">
              Your email <span className="text-wp-red">*</span>
              <input
                className="input mt-1"
                type="email"
                value={submitterEmail}
                onChange={(e) => setSubmitterEmail(e.target.value)}
                maxLength={254}
                autoComplete="email"
                required
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-wp-stone pt-4">
            <button
              type="button"
              className="btn-ghost inline-flex items-center gap-1.5 text-sm"
              onClick={() => setStep("welcome")}
            >
              <ArrowLeft size={14} />
              Back
            </button>
            <button type="submit" className="btn-primary" disabled={!canSubmit}>
              {submit.isPending ? "Submitting…" : "Submit test idea"}
            </button>
          </div>
        </form>
      ) : null}

      {step === "success" ? (
        <SuccessStep
          groupName={workspace.group_name}
          title={created?.title ?? title}
          onAnother={() => {
            setTitle("");
            setDescription("");
            setTeamId(null);
            setCreated(null);
            setError(null);
            setStep("form");
          }}
        />
      ) : null}
    </Shell>
  );
}

function WelcomeStep({
  groupName,
  onContinue,
}: {
  groupName: string;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-5 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-wp-red/10 text-wp-red">
        <FlaskConical size={22} />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-wp-ink">Share a test idea</h1>
        <p className="mt-2 text-sm text-wp-slate">
          Got an experiment that should be on the{" "}
          <strong className="font-medium text-wp-ink">{groupName}</strong> A/B Testing
          backlog? Submit it here — no account needed. Product managers will be
          notified as soon as you send it.
        </p>
      </div>
      <button type="button" className="btn-primary w-full sm:w-auto" onClick={onContinue}>
        Create a new test idea
      </button>
      <p className="text-xs text-wp-slate">
        Already have a Waypoint account?{" "}
        <Link to="/login" className="font-medium text-wp-ink underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

function SuccessStep({
  groupName,
  title,
  onAnother,
}: {
  groupName: string;
  title: string;
  onAnother: () => void;
}) {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
        <CheckCircle2 size={22} />
      </div>
      <div>
        <h1 className="text-lg font-semibold text-wp-ink">Test idea submitted</h1>
        <p className="mt-2 text-sm text-wp-slate">
          <strong className="font-medium text-wp-ink">{title}</strong> is now on the{" "}
          {groupName} A/B Testing backlog. Product managers have been notified and
          will follow up if they need more detail.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
        <button type="button" className="btn-primary" onClick={onAnother}>
          Submit another test idea
        </button>
        <Link to="/login" className="btn-secondary">
          Sign in to Waypoint
        </Link>
      </div>
    </div>
  );
}

function Shell({
  children,
  groupName,
}: {
  children: ReactNode;
  groupName?: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-wp-stone/30 to-white p-4">
      <div className="card-surface w-full max-w-lg space-y-4 p-6">
        <div className="text-center">
          <div className="text-xl font-bold text-wp-red">Waypoint</div>
          {groupName ? (
            <p className="mt-1 text-xs uppercase tracking-wide text-wp-slate">
              {groupName}
            </p>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
