import { useState } from "react";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { checkPassword, passwordIsValid } from "../lib/password";
import { CopyButton } from "./CopyButton";
import { cn } from "../lib/cn";

/**
 * Password input for admin flows (create user, reset password).
 * Bundles four things every admin needs at once:
 *
 *   * masked/unmasked toggle (peek without pasting)
 *   * "Generate" button that hits the server-side generator so the
 *     client doesn't have to replicate the crypto/policy dance
 *   * live checklist against the shared password policy
 *   * copy-to-clipboard while the plaintext is still visible
 *
 * The parent owns the value + validity state; this component is a
 * controlled input plus decoration.
 */
export function PasswordField({
  id,
  value,
  onChange,
  email,
  autoFocus,
  disabled,
  placeholder = "Enter or generate a password",
  showChecklist = true,
  allowGenerate = true,
  generateUrl = "/users/password/generate",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Used by the checklist to reject "roland's password" style choices. */
  email?: string | null;
  autoFocus?: boolean;
  disabled?: boolean;
  placeholder?: string;
  showChecklist?: boolean;
  allowGenerate?: boolean;
  /**
   * Backend endpoint to POST to for a fresh password. Defaults to
   * the admin-gated `/users/password/generate` since that's where
   * the field lives for most flows. The public reset page overrides
   * with `/auth/password/generate` because it runs unauthenticated.
   */
  generateUrl?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [generating, setGenerating] = useState(false);
  const checks = checkPassword(value, email ?? null);
  const anyEntered = value.length > 0;

  async function generate() {
    try {
      setGenerating(true);
      // Generator lives on the server so the source of randomness is
      // crypto-quality and the alphabet stays in sync with the policy.
      const { password } = await api<{ password: string }>(generateUrl, {
        method: "POST",
        body: "{}",
      });
      onChange(password);
      setVisible(true);
    } catch (err) {
      // Surface via alert so the admin doesn't get stuck. Very rare.
      alert(`Password generator failed: ${(err as Error).message ?? "unknown error"}`);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            id={id}
            type={visible ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoFocus={autoFocus}
            disabled={disabled}
            placeholder={placeholder}
            autoComplete="new-password"
            spellCheck={false}
            className="w-full rounded-md border border-wp-stone bg-white px-3 py-2 pr-10 text-sm font-mono text-wp-ink shadow-sm focus:border-wp-red focus:outline-none focus:ring-1 focus:ring-wp-red disabled:bg-wp-stone/30"
          />
          <button
            type="button"
            aria-label={visible ? "Hide password" : "Show password"}
            onClick={() => setVisible((v) => !v)}
            className="absolute inset-y-0 right-2 flex items-center text-wp-slate hover:text-wp-ink"
            tabIndex={-1}
          >
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {allowGenerate ? (
          <button
            type="button"
            onClick={generate}
            disabled={disabled || generating}
            className="btn-secondary inline-flex items-center gap-1.5"
            title="Generate a strong password on the server"
          >
            <RefreshCw size={13} className={generating ? "animate-spin" : ""} />
            Generate
          </button>
        ) : null}
        {anyEntered ? (
          <CopyButton value={value} label="Copy" />
        ) : null}
      </div>
      {showChecklist && anyEntered ? (
        <ul className="rounded-md border border-wp-stone bg-wp-stone/10 p-2 text-xs">
          {checks.map((c) => (
            <li
              key={c.label}
              className={cn(
                "flex items-center gap-2",
                c.passed ? "text-emerald-700" : "text-red-700",
              )}
            >
              {/* Green ✓ for pass, red ✕ for fail. Both use a filled
                  circle glyph so scanning the list is a color +
                  shape signal, not just color (matters for anyone
                  with red/green color-vision deficiency). */}
              <span
                aria-hidden
                className={cn(
                  "inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[10px] font-bold text-white",
                  c.passed ? "bg-emerald-500" : "bg-red-500",
                )}
              >
                {c.passed ? "✓" : "✕"}
              </span>
              {c.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export { passwordIsValid };
