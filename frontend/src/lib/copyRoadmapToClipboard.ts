import { toBlob } from "html-to-image";

/**
 * Snapshot the currently-visible portion of a roadmap DOM subtree
 * (label column + visible chart area) as a PNG and write it to the
 * system clipboard so the user can paste it directly into Google
 * Slides, Docs, Keynote, etc.
 *
 * Deliberately different from the PDF export path in three ways:
 *
 *   1. Captures ONLY what's currently visible — uses `clientWidth`/
 *      `clientHeight` on the root scroll container, not the full
 *      `scrollWidth`/`scrollHeight`. The user asked for "the visible
 *      dates", so respecting the live scroll position + zoom level is
 *      the whole point. Bars that extend past the visible edge are
 *      cropped naturally at the scroll frame, exactly as they appear
 *      on-screen.
 *   2. Excludes the horizontal scrollbar chrome. `clientWidth`/
 *      `clientHeight` already exclude scrollbar tracks on most
 *      platforms; we ALSO force `overflow: hidden` on the capture
 *      root for the duration of the snapshot so any residual
 *      scrollbar band (macOS scroll bars in "always show", overlay
 *      scrollbars in some Linux themes) is guaranteed to be gone
 *      from the PNG. The original overflow value is restored in the
 *      `finally` block so an aborted / thrown capture never leaves
 *      the roadmap stuck in a hidden-overflow state.
 *   3. Does NOT toggle `pdfMode` on the Gantt. The PDF exporter
 *      swaps in solid fills, unclips scroll frames, and clamps the
 *      chart's left edge — none of which the user wants here. This
 *      helper is a pure DOM-to-PNG snapshot of the live view.
 *
 * Falls back to downloading the PNG in browsers where clipboard
 * image writes are blocked (Firefox without `dom.events.asyncClipboard.clipboardItem`,
 * plain-HTTP contexts that aren't localhost, older Safari, etc.).
 * The caller can distinguish the two outcomes via the returned
 * `status` and surface the appropriate toast copy.
 */
export async function copyRoadmapToClipboard(
  root: HTMLElement,
  filename = "roadmap",
): Promise<{ status: "clipboard" | "download" }> {
  // `clientWidth` already excludes vertical scrollbar chrome on
  // most platforms, and `clientHeight` excludes horizontal
  // scrollbar chrome — but macOS ships with "Always show scroll
  // bars" as an opt-in, and some overlay-scrollbar themes still
  // paint a translucent track that html-to-image will faithfully
  // reproduce. Force `overflow: hidden` for the duration of the
  // capture so the track is definitely gone from the PNG. Saved
  // and restored on the inline style so any Tailwind class-driven
  // overflow rule is untouched.
  const prevOverflow = root.style.overflow;
  root.style.overflow = "hidden";
  try {
    const blob = await toBlob(root, {
      width: root.clientWidth,
      height: root.clientHeight,
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: "#ffffff",
      filter: (node) => {
        if (!(node instanceof HTMLElement)) return true;
        const tag = node.tagName;
        // Skip iframes/embeds we don't own — nothing in the
        // roadmap uses them today, but the filter guards against
        // a future widget accidentally tanking the capture with
        // a cross-origin frame.
        if (tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") return false;
        // Author-supplied opt-out — reused for consistency with
        // the PDF exporter so anything marked
        // `data-pdf-exclude="true"` also stays out of the copy.
        if (node.dataset.pdfExclude === "true") return false;
        return true;
      },
    });
    if (!blob) throw new Error("Capture returned no image");

    // Feature-detect clipboard image support. `navigator.clipboard`
    // exists in every modern browser but `.write` (as opposed to
    // `.writeText`) requires a secure context AND
    // `ClipboardItem` support — Firefox gated the latter behind a
    // pref until v127, and some corporate policies still disable
    // it entirely. Fall back to a plain PNG download in every
    // failure mode so the user always gets an artefact.
    const clipboardSupported =
      typeof window !== "undefined" &&
      typeof ClipboardItem !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.clipboard != null &&
      typeof navigator.clipboard.write === "function";

    if (clipboardSupported) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        return { status: "clipboard" };
      } catch {
        // fall through to download — permission denied, insecure
        // context (http://non-localhost), or a rare user-gesture
        // race with focus loss.
      }
    }

    downloadBlob(blob, `${filename}.png`);
    return { status: "download" };
  } finally {
    root.style.overflow = prevOverflow;
  }
}

/**
 * Trigger a browser download of an in-memory blob. Object URLs are
 * revoked on the next tick so the browser has a chance to consume
 * the URL before we release it — revoking synchronously has been
 * observed to abort the download in Chromium on very fast machines.
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
