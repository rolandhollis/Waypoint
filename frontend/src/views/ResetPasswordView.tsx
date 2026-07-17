import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, KeyRound } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { PasswordField, passwordIsValid } from "../components/PasswordField";

type ProbeResponse = { live: boolean; ttlMinutes: number };

/**
 * Landing page for the reset link mailed from /forgot-password.
 * Reads the token from the URL, probes the server to make sure
 * it's still redeemable (so we can show "this link expired"
 * without wasting a keystroke), and — on success — POSTs the new
 * password to /api/auth/reset-password.
 *
 * Reuses the admin PasswordField so the checklist, generator, and
 * copy button behave identically to the admin-driven reset. The
 * server enforces the same policy so any hand-crafted payload gets
 * rejected with a friendly message.
 */
export function ResetPasswordView() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[] | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  // Probe up front so users don't waste time typing into a form
  // backed by a dead link. Also gives us the TTL to display so the
  // "30 minutes" phrasing in the email matches what shows here.
  const probe = useQuery<ProbeResponse>({
    queryKey: ["reset-probe", token],
    queryFn: () =>
      api<ProbeResponse>(`/auth/reset-password/probe?token=${encodeURIComponent(token)}`),
    enabled: !!token,
    staleTime: 5000,
  });

  const submit = useMutation({
    mutationFn: () =>
      api<void>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      }),
    onSuccess: () => {
      setSucceeded(true);
      // Bounce to the login screen after a short beat so the user
      // sees the confirmation and lands in a place they can sign in
      // with the password they just chose.
      setTimeout(() => navigate("/login", { replace: true }), 1500);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message || "Reset failed.");
        const d = (err.body as { details?: string[] } | undefined)?.details;
        setDetails(Array.isArray(d) ? d : null);
        return;
      }
      setError((err as Error).message ?? "Reset failed.");
      setDetails(null);
    },
  });

  if (!token) return <Navigate to="/forgot-password" replace />;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDetails(null);
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    submit.mutate();
  }

  const clientValid = passwordIsValid(password);
  const canSubmit =
    clientValid && password === confirm && !submit.isPending && probe.data?.live;

  // Small "why disabled" hint that shows the FIRST reason submit
  // isn't clickable. The full policy checklist is right above (via
  // PasswordField's own checklist), but a single-line summary next
  // to the button saves people scrolling to figure out what's still
  // missing. Kept intentionally terse.
  const disabledReason = submit.isPending
    ? null
    : !password
      ? "Enter a new password."
      : !clientValid
        ? "Password doesn't meet all the requirements in the checklist above."
        : !confirm
          ? "Confirm the new password to continue."
          : password !== confirm
            ? "Passwords don't match."
            : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-wp-stone/30 to-white">
      <div className="card-surface w-full max-w-md space-y-4 p-6">
        <div className="text-center">
          <div className="text-xl font-bold text-wp-red">Waypoint</div>
          <p className="mt-1 text-sm text-wp-slate">Pick a new password</p>
        </div>

        {probe.isLoading ? (
          <p className="text-center text-sm text-wp-slate">Checking your link…</p>
        ) : probe.data && !probe.data.live ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-red-900">
              This reset link is invalid or has expired. Reset links only work
              once and are good for {probe.data?.ttlMinutes ?? 30} minutes.
            </div>
            <Link to="/forgot-password" className="btn-primary w-full justify-center">
              Request a new link
            </Link>
          </div>
        ) : succeeded ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-900">
              <div className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                <div>
                  Password updated. Taking you to the sign-in screen…
                </div>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <p className="text-sm text-wp-slate">
              Choose a new password. All your existing sessions will be signed
              out for safety.
            </p>

            <div>
              <label
                htmlFor="reset-password"
                className="block text-xs font-medium text-wp-slate"
              >
                New password
              </label>
              <div className="mt-1">
                <PasswordField
                  id="reset-password"
                  value={password}
                  onChange={setPassword}
                  autoFocus
                  allowGenerate
                  generateUrl="/auth/password/generate"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="reset-confirm"
                className="block text-xs font-medium text-wp-slate"
              >
                Confirm new password
              </label>
              <input
                id="reset-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1 w-full rounded-md border border-wp-stone bg-white px-3 py-2 text-sm text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red"
              />
              {password && confirm && password !== confirm ? (
                <p className="mt-1 text-xs text-red-700">Passwords don't match.</p>
              ) : null}
            </div>

            {error ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {error}
                {details && details.length ? (
                  <ul className="mt-1 list-disc pl-4">
                    {details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit}
              className="btn-primary w-full justify-center"
            >
              <KeyRound size={14} />
              {submit.isPending ? "Saving…" : "Save new password"}
            </button>
            {disabledReason ? (
              <p className="text-center text-[11px] text-wp-slate">{disabledReason}</p>
            ) : null}

            <p className="text-center text-[11px] text-wp-slate">
              <Link to="/login" className="hover:underline">
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
