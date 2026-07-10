import { useState } from "react";
import { AlertTriangle, Eye, EyeOff } from "lucide-react";
import { CopyButton } from "./CopyButton";

/**
 * One-time reveal of a newly-generated / freshly-reset password.
 * Shown to the admin immediately after the server responds; the
 * plaintext is echoed in that response and never fetched again.
 *
 * The card leans on visual weight (yellow banner + explicit "won't
 * see this again" copy) because the consequences of the admin
 * closing the dialog without copying are annoying — the user gets
 * their password reset again.
 */
export function RevealPasswordCard({
  password,
  email,
  variant = "created",
}: {
  password: string;
  email?: string;
  variant?: "created" | "reset";
}) {
  const [masked, setMasked] = useState(false);

  const title =
    variant === "reset" ? "Password reset — copy it now" : "User created — copy the password now";
  const bodyIntro =
    variant === "reset"
      ? "The new password is shown below. It's hashed on the server, so this is the only time you'll see the plaintext."
      : "The password is shown below. It's hashed on the server, so this is the only time you'll see the plaintext.";

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 shadow-sm">
      <div className="flex items-start gap-2 text-amber-900">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <p className="mt-1 text-xs">
            {bodyIntro}
            {email ? (
              <>
                {" "}Share it with <span className="font-mono">{email}</span> through a secure
                channel.
              </>
            ) : null}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2">
        <code className="flex-1 select-all font-mono text-sm text-wp-ink">
          {masked ? "•".repeat(password.length) : password}
        </code>
        <button
          type="button"
          onClick={() => setMasked((m) => !m)}
          className="inline-flex items-center gap-1 rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-slate hover:text-wp-ink"
          aria-label={masked ? "Show password" : "Hide password"}
          tabIndex={-1}
        >
          {masked ? <Eye size={13} /> : <EyeOff size={13} />}
          {masked ? "Show" : "Hide"}
        </button>
        <CopyButton value={password} />
      </div>
    </div>
  );
}
