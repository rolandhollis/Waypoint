import { toPng } from "html-to-image";
import jsPDF from "jspdf";

/**
 * Snapshot a roadmap DOM subtree and download it as a single-page PDF.
 *
 * Design goals:
 *   * One-click. No print dialog, no "Save as PDF" step for the user.
 *   * Poster-style: the PDF page is sized to the natural width/height
 *     of the roadmap content, so nothing is cropped and PDF viewers
 *     can zoom to whatever level the user wants. Roadmaps are
 *     typically wide, and forcing a letter/A4 page would either scale
 *     text to unreadable sizes or paginate horizontally in a way that
 *     splits bars mid-item.
 *   * Full width: we snapshot at `scrollWidth`/`scrollHeight`
 *     regardless of the viewport, so even a 12-month view exports
 *     completely rather than cutting off at the visible scroll frame.
 *     The caller is expected to toggle any `overflow-hidden` /
 *     `overflow-x-auto` clips off (via a `pdfMode` render flag or
 *     similar) BEFORE invoking this function — otherwise the outer
 *     ancestor's clip walls cap `scrollWidth` at the visible viewport
 *     and the resulting PNG shows an empty chart area.
 *
 * Notes on quality:
 *   * `pixelRatio: 2` gives crisp text and phase fills on modern PDF
 *     viewers without ballooning the file. The Gantt is SVG, so
 *     html-to-image inlines it into the resulting PNG faithfully —
 *     provided the SVG uses solid `fill="#..."` attributes rather
 *     than `url(#pattern)` references, which Chromium's exporter
 *     silently drops when serialising the DOM through the
 *     foreignObject-in-data-URI path. GanttTimeline's `pdfMode`
 *     branch handles that swap.
 *   * We explicitly set a white background so any translucent tokens
 *     in the roadmap header (bg-white/60) don't render as
 *     transparent-on-transparent (which shows up as pitch black in
 *     some PDF viewers).
 *
 * The caller decides which element to snapshot; usually a wrapper
 * ref-bound to the roadmap header + Gantt + Unscheduled list, so the
 * exported PDF matches what the user sees in the viewport.
 */
export async function exportRoadmapToPdf(opts: {
  /** The DOM element to snapshot. Full scroll width/height is captured. */
  root: HTMLElement;
  /** Downloaded filename (without extension). Defaults to `roadmap-YYYY-MM-DD`. */
  filename?: string;
}): Promise<void> {
  const { root } = opts;

  // The caller (RoadmapView.handleExportPdf) has already flushed
  // pdfMode=true synchronously via `flushSync`, so React's commit is
  // done — but the browser hasn't necessarily PAINTED the new layout
  // yet. Reading scrollWidth below forces a layout reflow, which is
  // enough to pick up the new geometry; the RAF here additionally
  // waits for one paint tick so html-to-image's inline-style /
  // computed-style collection (which walks the live DOM) sees the
  // unclipped layout. Without this yield, we've seen html-to-image
  // capture the pre-pdfMode DOM sizes on first click after the
  // component mounts — the paint-tick fixes it deterministically.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  // scrollWidth/Height capture everything inside the subtree, including
  // content that overflows the immediate viewport IF the intermediate
  // ancestors have `overflow: visible`. In PDF mode the roadmap
  // deliberately unclips its scroll frames so this returns the natural
  // chart width (label column + full SVG). Fallback to offsetWidth
  // /Height for defensive-programming purposes — if scroll* returned 0
  // (element itself doesn't scroll and has no overflowing children),
  // we still need concrete numbers for html-to-image.
  const width = Math.max(root.scrollWidth, root.offsetWidth);
  const height = Math.max(root.scrollHeight, root.offsetHeight);

  const dataUrl = await toPng(root, {
    width,
    height,
    pixelRatio: 2,
    backgroundColor: "#ffffff",
    // Skip iframes/embeds we don't own — nothing in the roadmap uses
    // them, but the filter guards against a future header widget
    // accidentally tanking the export with a cross-origin frame.
    filter: (node) => {
      if (!(node instanceof HTMLElement)) return true;
      const tag = node.tagName;
      if (tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") return false;
      // Author-supplied opt-out for chrome that shouldn't appear in
      // the exported artefact (e.g. the export button itself).
      if (node.dataset.pdfExclude === "true") return false;
      return true;
    },
  });

  // jsPDF accepts a custom page size in points; 1pt = 1/72in. Passing
  // pixel-derived numbers directly means the exported PDF is exactly
  // 1:1 with the source at 72 DPI (the pixelRatio: 2 above gives the
  // internal raster 2x resolution, which PDF viewers scale down for
  // crisp rendering). Orientation just reflects which dimension is
  // larger — a wide 12-month export naturally becomes landscape, a
  // tall/narrow single-team export naturally becomes portrait — so
  // the page metadata matches the artefact regardless of shape.
  const pdf = new jsPDF({
    orientation: width > height ? "landscape" : "portrait",
    unit: "pt",
    format: [width, height],
    // Compress to keep the PDF a reasonable size for large 12-month
    // exports (uncompressed 12-month roadmaps can hit 8-10MB).
    compress: true,
  });

  pdf.addImage(dataUrl, "PNG", 0, 0, width, height);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = opts.filename ?? `roadmap-${stamp}`;
  pdf.save(`${filename}.pdf`);
}
