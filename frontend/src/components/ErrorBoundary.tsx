import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Top-level error boundary. Wraps the whole app so any uncaught
 * render / lifecycle exception surfaces a graceful "Something went
 * wrong" fallback instead of blanking the DOM.
 *
 * Why this exists (and why every future top-level tree should keep
 * it): React unmounts the root when a render error escapes the
 * component tree, which manifests as a completely white viewport
 * with no navigation, no reload prompt, and no visible clue that
 * anything happened. That's an especially painful failure mode in
 * production because users have no idea whether the app is loading,
 * offline, or broken. Rendering *anything* instead — even a plain
 * "reload the page" card — gives them a way out and keeps the
 * chrome up long enough to grab a screenshot for a bug report.
 *
 * The fallback intentionally does not attempt to recover the
 * offending subtree in place. Rebuilding state after an uncaught
 * error is a footgun (queries, mutations, and refs are all in
 * indeterminate condition) and any auto-retry loop would just
 * blast the same crash over and over. Reload is the honest option.
 *
 * In development, the raw stack is rendered so the failure is
 * immediately actionable while you're iterating.
 */
type State = {
  error: Error | null;
  info: ErrorInfo | null;
};

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to the browser console so bug reports include a stack.
    // Keep it as `error` (not `warn`) so it also shows up in the
    // Fly log stream if we ever add a client-side log forwarder.
    console.error("Uncaught render error:", error, info);
    this.setState({ info });
  }

  override render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    // Note: `import.meta.env.DEV` is inlined by Vite at build time —
    // production bundles will strip the stack panel entirely.
    const showStack = Boolean(import.meta.env.DEV);
    return (
      <div className="flex min-h-screen items-center justify-center bg-wp-bg p-6">
        <div className="card-surface max-w-lg space-y-3 p-6 text-sm text-wp-slate">
          <h1 className="text-lg font-semibold text-wp-ink">Something went wrong.</h1>
          <p>
            Waypoint hit an unexpected error while rendering the page. Reload the page to
            try again. If the issue keeps happening, take a screenshot of this screen (or
            the browser console) and send it to the Waypoint admin.
          </p>
          <div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
          {showStack ? (
            <details className="rounded-md border border-wp-stone bg-wp-stone/20 p-3 text-xs">
              <summary className="cursor-pointer font-medium text-wp-ink">
                Error details (dev only)
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-wp-slate">
                {error.message}
                {"\n"}
                {error.stack ?? ""}
                {info?.componentStack ?? ""}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    );
  }
}
