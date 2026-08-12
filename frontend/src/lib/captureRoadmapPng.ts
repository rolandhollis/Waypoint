import { toPng } from "html-to-image";

/**
 * Snapshot a roadmap DOM node (typically `[data-roadmap-capture-root]`)
 * at full scroll size — same capture contract as the PDF exporter.
 * Returns a PNG data URL suitable for pptxgenjs `addImage({ data })`.
 *
 * Caller must put the roadmap into the desired filter/zoom/style and
 * (usually) `pdfMode` before calling, then await one paint tick.
 */
export async function captureRoadmapPng(root: HTMLElement): Promise<string> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const width = Math.max(root.scrollWidth, root.offsetWidth, 1);
  const height = Math.max(root.scrollHeight, root.offsetHeight, 1);

  return toPng(root, {
    width,
    height,
    pixelRatio: 2,
    cacheBust: true,
    backgroundColor: "#ffffff",
    filter: (node) => {
      if (!(node instanceof HTMLElement)) return true;
      const tag = node.tagName;
      if (tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") return false;
      if (node.dataset.pdfExclude === "true") return false;
      return true;
    },
  });
}
