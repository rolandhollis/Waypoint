import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { User } from "../lib/types";

/**
 * Password-mode login screen. Standard email + password form plus a
 * self-serve "forgot password" link that kicks off an email-based
 * reset. No "sign up" (roster stays admin-managed) and no auto
 * lockout copy — the server returns a friendly 429 when the login
 * limiter fires.
 */
export function LoginView() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  // Persists across page reloads so an unchecked box on the previous
  // login doesn't secretly become checked next time. Defaults off so
  // shared machines don't inherit a 30-day cookie by surprise.
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const login = useMutation({
    mutationFn: (input: { email: string; password: string; remember_me: boolean }) =>
      api<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: async () => {
      // Prime the cache and drop any prior 401 error state.
      await qc.invalidateQueries();
      navigate("/board", { replace: true });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError("Too many failed attempts. Try again in a few minutes.");
          return;
        }
        setError(err.message || "Login failed.");
        return;
      }
      setError((err as Error).message ?? "Login failed.");
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    login.mutate({ email: email.trim(), password, remember_me: rememberMe });
  }

  const canSubmit = email.trim().length > 0 && password.length > 0 && !login.isPending;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-wp-stone/30 to-white">
      <form
        onSubmit={submit}
        className="card-surface w-full max-w-sm space-y-4 p-6"
      >
        <div className="text-center">
          <div className="text-xl font-bold text-wp-red">Waypoint</div>
          <p className="mt-1 text-sm text-wp-slate">Sign in with your email and password.</p>
        </div>

        <div>
          <label htmlFor="login-email" className="block text-xs font-medium text-wp-slate">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
            className="mt-1 w-full rounded-md border border-wp-stone bg-white px-3 py-2 text-sm text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red"
          />
        </div>

        <div>
          <label htmlFor="login-password" className="block text-xs font-medium text-wp-slate">
            Password
          </label>
          <div className="relative mt-1">
            <input
              id="login-password"
              type={visible ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-wp-stone bg-white px-3 py-2 pr-10 text-sm text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red"
            />
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "Hide password" : "Show password"}
              className="absolute inset-y-0 right-2 flex items-center text-wp-slate hover:text-wp-ink"
              tabIndex={-1}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-wp-slate">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="h-4 w-4 accent-wp-red"
          />
          Remember me for 30 days
        </label>

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
          <LogIn size={14} />
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-center text-[11px] text-wp-slate">
          <Link
            to="/forgot-password"
            className="font-medium text-wp-red hover:underline"
          >
            Forgot your password?
          </Link>
        </p>
      </form>
    </div>
  );
}
