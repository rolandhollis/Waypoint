import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Link2, X } from "lucide-react";
import { ProjectDetailBody } from "../components/ProjectDetailBody";

/**
 * Standalone `/projects/:id` page — the bookmarkable / shareable
 * counterpart to `ProjectDetailPanel`. Uses the same shared
 * `ProjectDetailBody` so every affordance stays in lock-step.
 *
 * Content that belongs to the URL bar (item title) is rendered by
 * the body; the page shell only adds a Copy-link button so a PM can
 * hand a teammate the exact URL they're looking at without picking
 * it out of the address bar. The auth guard in `App.tsx` already
 * bounces unauthenticated visits through the login flow via
 * `postLoginRedirect`, so a fresh tab pointed at `/projects/:id`
 * lands the user back on the page after signing in.
 */
export function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  // React-router doesn't type-narrow to a required param, so a
  // route mis-configuration would render this page with `id`
  // undefined. Guard defensively — send the user home rather than
  // crash the tree.
  if (!id) {
    return <Navigate to="/board" replace />;
  }

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col p-4">
      <div className="mb-2 flex items-center justify-end">
        <CopyLinkButton />
      </div>
      <div className="card-surface flex flex-1 flex-col overflow-hidden">
        <ProjectDetailBody projectId={id} variant="page" />
      </div>
    </div>
  );
}

/**
 * Copy `window.location.href` to the OS clipboard + surface a small
 * toast confirming success (or the "copy from address bar" fallback
 * when the Clipboard API is unavailable — older browsers, plain-HTTP
 * contexts). Mirrors the `handleCopyLink` behaviour on the Roadmap
 * toolbar (`RoadmapView.tsx` ~line 276) so the affordance reads the
 * same everywhere: same icon, same success/error copy, same 6-second
 * auto-dismiss timer.
 */
function CopyLinkButton() {
  type ToastVariant = "success" | "error";
  const [toast, setToast] = useState<{ message: string; variant: ToastVariant } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  async function handleCopyLink() {
    const href = window.location.href;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(href);
        setToast({ message: "Link copied to clipboard.", variant: "success" });
        return;
      }
      throw new Error("Clipboard API unavailable");
    } catch (err) {
      console.error("Copy project link failed", err);
      setToast({
        message: "Couldn't copy the link. Copy it from your browser's address bar instead.",
        variant: "error",
      });
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary !py-1 !text-xs"
        onClick={handleCopyLink}
        title="Copy a link to this item to your clipboard"
      >
        <Link2 size={12} />
        Copy link
      </button>
      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
        >
          <div
            className={
              toast.variant === "success"
                ? "pointer-events-auto flex max-w-md items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 shadow-lg"
                : "pointer-events-auto flex max-w-md items-start gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 shadow-lg"
            }
          >
            <span className="mt-0.5 flex-1">{toast.message}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss notification"
              className={
                toast.variant === "success"
                  ? "shrink-0 rounded p-0.5 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-900"
                  : "shrink-0 rounded p-0.5 text-rose-700 hover:bg-rose-100 hover:text-rose-900"
              }
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
