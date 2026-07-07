import type { UseMutationResult } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { ApiError } from "../lib/api";

type AnyMutation = Pick<UseMutationResult, "isError" | "error" | "reset">;

/**
 * Small inline banner that surfaces the last error from a TanStack Query
 * mutation. Without this, backend validation failures are invisible: the
 * button just flickers "Saving…" and returns to idle while the draft
 * silently sticks around.
 *
 * Renders nothing when the mutation is idle or successful. Prefer placing
 * this immediately above the primary action button so the failure is
 * next to the thing the user just clicked.
 */
export function MutationErrorBanner({
  mutation,
  className = "",
}: {
  mutation: AnyMutation;
  className?: string;
}) {
  if (!mutation.isError) return null;
  const err = mutation.error;
  const message = err instanceof ApiError
    ? err.message
    : err instanceof Error
      ? err.message
      : "Something went wrong. Try again.";
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 ${className}`}
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{message}</div>
      <button
        type="button"
        onClick={() => mutation.reset()}
        className="ml-1 shrink-0 rounded px-1 text-red-700 hover:bg-red-100"
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
}
