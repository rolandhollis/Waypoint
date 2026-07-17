import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, Mail } from "lucide-react";
import { api, ApiError } from "../lib/api";

/**
 * Public "forgot password" landing page. Takes an email address,
 * asks the server to mail a one-time reset link, and always shows
 * the same success screen regardless of whether the address is
 * known — we deliberately don't leak account existence via the UI.
 *
 * The server-side flow enforces its own rate limits; here we just
 * translate 429s into user-friendly copy. Any other error becomes
 * a generic "try again" message so the response shape doesn't hint
 * at the underlying condition either.
 */
export function ForgotPasswordView() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (input: { email: string }) =>
      api<void>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => setSubmitted(true),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many reset requests for that email. Try again in a few minutes.");
        return;
      }
      // Everything else collapses to a generic message — again to
      // avoid leaking whether the address exists.
      setError("We couldn't process that request. Try again in a moment.");
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    send.mutate({ email: email.trim() });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-wp-stone/30 to-white">
      <div className="card-surface w-full max-w-sm space-y-4 p-6">
        <div className="text-center">
          <div className="text-xl font-bold text-wp-red">Waypoint</div>
          <p className="mt-1 text-sm text-wp-slate">Reset your password</p>
        </div>

        {submitted ? (
          <div className="space-y-3 text-sm text-wp-ink">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-900">
              <div className="flex items-start gap-2">
                <Mail size={16} className="mt-0.5 shrink-0" />
                <div>
                  If an account exists for that address, we've just sent a
                  password reset link. It expires in <strong>30 minutes</strong>.
                </div>
              </div>
            </div>
            <p className="text-xs text-wp-slate">
              Didn't get anything? Check your spam folder, or try again — the
              link only shows up if we recognize the address.
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => { setSubmitted(false); setEmail(""); }}
                className="btn-secondary w-full justify-center"
              >
                Try another email
              </button>
              <Link to="/login" className="btn-ghost w-full justify-center">
                <ArrowLeft size={14} /> Back to sign in
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-wp-slate">
              Enter your account email and we'll send you a one-time link to
              choose a new password.
            </p>
            <div>
              <label
                htmlFor="forgot-email"
                className="block text-xs font-medium text-wp-slate"
              >
                Email
              </label>
              <input
                id="forgot-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="mt-1 w-full rounded-md border border-wp-stone bg-white px-3 py-2 text-sm text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red"
              />
            </div>

            {error ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!email.trim() || send.isPending}
              className="btn-primary w-full justify-center"
            >
              <Mail size={14} />
              {send.isPending ? "Sending…" : "Send reset link"}
            </button>

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
