import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, KeyRound } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { PasswordField, passwordIsValid } from "../components/PasswordField";

type ProbeResponse = {
  live: boolean;
  purpose: "reset" | "invite" | null;
  ttlMinutes: number;
  name: string | null;
  email: string | null;
};

/**
 * Landing page for set-password links mailed from:
 *   * /forgot-password (purpose=reset)
 *   * admin Create user invite (purpose=invite)
 *
 * Reads the token from the URL, probes the server to make sure
 * it's still redeemable, and POSTs the new password to
 * /api/auth/reset-password. Copy adapts to invite vs reset.
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

  const probe = useQuery<ProbeResponse>({
    queryKey: ["reset-probe", token],
    queryFn: () =>
      api<ProbeResponse>(`/auth/reset-password/probe?token=${encodeURIComponent(token)}`),
    enabled: !!token,
    staleTime: 5000,
  });

  const isInvite = probe.data?.purpose === "invite";

  const submit = useMutation({
    mutationFn: () =>
      api<void>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      }),
    onSuccess: () => {
      setSucceeded(true);
      setTimeout(() => navigate("/login", { replace: true }), 1500);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message || "Couldn't save password.");
        const d = (err.body as { details?: string[] } | undefined)?.details;
        setDetails(Array.isArray(d) ? d : null);
        return;
      }
      setError((err as Error).message ?? "Couldn't save password.");
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

  const disabledReason = submit.isPending
    ? null
    : !password
      ? "Enter a password."
      : !clientValid
        ? "Password doesn't meet all the requirements in the checklist above."
        : !confirm
          ? "Confirm the password to continue."
          : password !== confirm
            ? "Passwords don't match."
            : null;

  const ttlLabel = (() => {
    const mins = probe.data?.ttlMinutes ?? 0;
    if (mins >= 60 * 24) {
      const days = Math.round(mins / (60 * 24));
      return `${days} day${days === 1 ? "" : "s"}`;
    }
    if (mins >= 60) {
      const hours = Math.round(mins / 60);
      return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `${mins || 30} minutes`;
  })();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-wp-stone/30 to-white">
      <div className="card-surface w-full max-w-md space-y-4 p-6">
        <div className="text-center">
          <div className="text-xl font-bold text-wp-red">Waypoint</div>
          <p className="mt-1 text-sm text-wp-slate">
            {isInvite ? "Set your password" : "Pick a new password"}
          </p>
        </div>

        {probe.isLoading ? (
          <p className="text-center text-sm text-wp-slate">Checking your link…</p>
        ) : probe.data && !probe.data.live ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-red-900">
              This link is invalid or has expired. Links only work once
              and are good for a limited time.
            </div>
            <Link to="/forgot-password" className="btn-primary w-full justify-center">
              Request a password reset
            </Link>
            <p className="text-center text-xs text-wp-slate">
              New account? Ask your admin to resend the invite from Users &amp; roles.
            </p>
          </div>
        ) : succeeded ? (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-900">
              <div className="flex items-start gap-2">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                <div>
                  {isInvite
                    ? "Password set. Taking you to the sign-in screen…"
                    : "Password updated. Taking you to the sign-in screen…"}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <p className="text-sm text-wp-slate">
              {isInvite ? (
                <>
                  Welcome{probe.data?.name ? `, ${probe.data.name}` : ""}. Choose a
                  password to finish creating your account
                  {probe.data?.email ? (
                    <>
                      {" "}
                      for <strong className="text-wp-ink">{probe.data.email}</strong>
                    </>
                  ) : null}
                  .
                </>
              ) : (
                <>
                  Choose a new password. All your existing sessions will be signed
                  out for safety. This link expires in {ttlLabel}.
                </>
              )}
            </p>

            <div>
              <label
                htmlFor="reset-password"
                className="block text-xs font-medium text-wp-slate"
              >
                {isInvite ? "Password" : "New password"}
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
                Confirm password
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
              {submit.isPending
                ? "Saving…"
                : isInvite
                  ? "Set password & continue"
                  : "Save new password"}
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
