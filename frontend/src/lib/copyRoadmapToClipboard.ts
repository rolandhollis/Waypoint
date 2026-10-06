import { toCanvas } from "html-to-image";

/**
 * Snapshot the roadmap as a PNG and write it to the system clipboard
 * so the user can paste it into Google Slides, Docs, Keynote, etc.
 *
 * Capture contract (matches the on-screen Gantt, not the PDF export):
 *
 *   1. Horizontal: only the dates currently in the web view.
 *   2. Vertical: the full board height (`scrollHeight`).
 *   3. No scrollbar chrome on the clone.
 *
 * Only `navigator.clipboard.write` with an `image/png` Blob is used.
 * The older execCommand / DataTransfer File fallback copied the
 * filename (`roadmap.png`) as text, which is worse than failing.
 *
 * `clipboard.write` is invoked synchronously when this function is
 * entered (Promise-backed `ClipboardItem`) so the click's user
 * activation is still valid. Callers must not `await` anything
 * before calling this.
 */
export async function copyRoadmapToClipboard(
  root: HTMLElement,
  filename = "roadmap",
): Promise<{ status: "clipboard" | "download" }> {
  const blobPromise = snapshotRoadmapPng(root);
  const writePromise = beginAsyncClipboardWrite(blobPromise);

  if (writePromise) {
    try {
      await writePromise;
      return { status: "clipboard" };
    } catch {
      try {
        const blob = await blobPromise;
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        return { status: "clipboard" };
      } catch {
        // fall through to download
      }
    }
  }

  const blob = await blobPromise;
  downloadBlob(blob, `${filename}.png`);
  return { status: "download" };
}

export async function snapshotRoadmapPng(root: HTMLElement): Promise<Blob> {
  const blob = await captureVisibleDatesFullHeight(root);
  if (!blob) throw new Error("Capture returned no image");
  return ensurePngBlob(blob);
}

function beginAsyncClipboardWrite(blobPromise: Promise<Blob>): Promise<void> | null {
  if (typeof ClipboardItem === "undefined") return null;
  if (!navigator.clipboard || typeof navigator.clipboard.write !== "function") return null;
  try {
    const item = new ClipboardItem({
      "image/png": blobPromise,
    });
    return navigator.clipboard.write([item]);
  } catch {
    return null;
  }
}

function ensurePngBlob(blob: Blob): Blob {
  if (blob.type === "image/png") return blob;
  return new Blob([blob], { type: "image/png" });
}

async function captureVisibleDatesFullHeight(root: HTMLElement): Promise<Blob | null> {
  const fullWidth = Math.max(root.scrollWidth, root.offsetWidth, 1);
  const fullHeight = Math.max(root.scrollHeight, root.offsetHeight, 1);
  const viewportWidth = Math.max(root.clientWidth, 1);
  const scrollLeft = Math.max(0, root.scrollLeft);
  const labelWidth = measureLabelColumnPx(root);

  const source = await toCanvas(root, {
    width: fullWidth,
    height: fullHeight,
    pixelRatio: 1,
    cacheBust: true,
    backgroundColor: "#ffffff",
    style: {
      overflow: "hidden",
      width: `${fullWidth}px`,
      height: `${fullHeight}px`,
    },
    filter: (node) => {
      if (!(node instanceof HTMLElement)) return true;
      const tag = node.tagName;
      if (tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT") return false;
      if (node.dataset.pdfExclude === "true") return false;
      return true;
    },
  });

  const cropped = cropToVisibleDates(source, {
    fullWidth,
    viewportWidth,
    scrollLeft,
    labelWidth,
  });

  return await canvasToPngBlob(cropped);
}

function measureLabelColumnPx(root: HTMLElement): number {
  const el = root.querySelector<HTMLElement>('[data-roadmap-label-column="true"]');
  if (!el) return 0;
  return Math.max(0, el.offsetWidth);
}

function cropToVisibleDates(
  source: HTMLCanvasElement,
  opts: {
    fullWidth: number;
    viewportWidth: number;
    scrollLeft: number;
    labelWidth: number;
  },
): HTMLCanvasElement {
  const { fullWidth, viewportWidth, scrollLeft, labelWidth } = opts;
  const scale = source.width / fullWidth;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(viewportWidth * scale));
  out.height = Math.max(1, source.height);
  const ctx = out.getContext("2d");
  if (!ctx) return source;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);

  const labelPx = Math.max(0, Math.min(out.width, Math.round(labelWidth * scale)));
  if (labelPx > 0) {
    ctx.drawImage(source, 0, 0, labelPx, source.height, 0, 0, labelPx, out.height);
  }

  const destChartW = out.width - labelPx;
  if (destChartW <= 0) return out;

  const srcChartX = Math.round((labelWidth + scrollLeft) * scale);
  const srcX = Math.max(0, Math.min(source.width, srcChartX));
  const srcW = Math.max(0, Math.min(destChartW, source.width - srcX));
  if (srcW > 0) {
    ctx.drawImage(source, srcX, 0, srcW, source.height, labelPx, 0, srcW, out.height);
  }
  return out;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

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
