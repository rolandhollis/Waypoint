import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowLeft, Mail, UserPlus } from "lucide-react";
import { api, ApiError } from "../lib/api";

/**
 * Public "request an account" landing. Collects email (+ optional
 * name/message), notifies super-admins, and always shows the same
 * success screen so we don't leak whether the address is already
 * on the roster. Admins create the user via Admin → Users; the
 * new user then gets the normal invite email.
 */
export function RequestAccessView() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (input: { email: string; name: string; message?: string }) =>
      api<void>("/auth/request-access", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => setSubmitted(true),
    onError: (err) => {
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many requests for that email. Try again in a few minutes.");
        return;
      }
      setError("We couldn't process that request. Try again in a moment.");
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const payload: { email: string; name: string; message?: string } = {
      email: email.trim(),
      name: name.trim(),
    };
    const m = message.trim();
    if (m) payload.message = m;
    send.mutate(payload);
  }

  const canSubmit =
    email.trim().length > 0 && name.trim().length > 0 && !send.isPending;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-wp-stone/30 to-white">
      <div className="card-surface w-full max-w-sm space-y-4 p-6">
        <div className="text-center">
          <div className="text-xl font-bold text-wp-red">Waypoint</div>
          <p className="mt-1 text-sm text-wp-slate">Request an account</p>
        </div>

        {submitted ? (
          <div className="space-y-3 text-sm text-wp-ink">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-900">
              <div className="flex items-start gap-2">
                <Mail size={16} className="mt-0.5 shrink-0" />
                <div>
                  Thanks — your request was sent to an admin. You'll get an
                  email invite once they create your account.
                </div>
              </div>
            </div>
            <p className="text-xs text-wp-slate">
              Already have an account? Sign in instead. If you don't hear
              back, follow up with your Waypoint admin.
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setSubmitted(false);
                  setEmail("");
                  setName("");
                  setMessage("");
                }}
                className="btn-secondary w-full justify-center"
              >
                Submit another request
              </button>
              <Link to="/login" className="btn-ghost w-full justify-center">
                <ArrowLeft size={14} /> Back to sign in
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-wp-slate">
              Accounts are created by an admin. Send a request and they'll
              follow up with an invite link.
            </p>
            <div>
              <label
                htmlFor="request-email"
                className="block text-xs font-medium text-wp-slate"
              >
                Work email
              </label>
              <input
                id="request-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="mt-1 w-full rounded-md border border-wp-stone bg-white px-3 py-2 text-sm text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red"
              />
            </div>
            <div>
              <label
                htmlFor="request-name"
                className="block text-xs font-medium text-wp-slate"
              >
                Full name
              </label>
              <input
                id="request-name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                className="mt-1 w-full rounded-md border border-wp-stone bg-white px-3 py-2 text-sm text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red"
              />
            </div>
            <div>
              <label
                htmlFor="request-message"
                className="block text-xs font-medium text-wp-slate"
              >
                Note for admin{" "}
                <span className="font-normal text-wp-slate/70">(optional)</span>
              </label>
              <textarea
                id="request-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={2000}
                rows={3}
                className="mt-1 w-full rounded-md border border-wp-stone bg-white px-3 py-2 text-sm text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red"
                placeholder="Team, why you need access, etc."
              />
            </div>

            {error ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!canSubmit}
              className="btn-primary w-full justify-center"
            >
              <UserPlus size={14} />
              {send.isPending ? "Sending…" : "Request access"}
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
