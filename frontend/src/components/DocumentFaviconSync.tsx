import { useEffect } from "react";
import { imageByLabel, useJiffPageContent, type JiffContentItem } from "../lib/jiffcontent";

const MANAGED_ATTR = "data-jiff-favicon";
const HIDDEN_ATTR = "data-jiff-favicon-hidden";

function guessImageMime(url: string): string {
  const path = (url.split("?")[0] ?? "").toLowerCase();
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "image/png";
}

function clearManagedFavicons() {
  document.head
    .querySelectorAll(`link[${MANAGED_ATTR}]`)
    .forEach((el) => el.remove());
}

function restoreStaticFavicons() {
  document.head.querySelectorAll(`link[${HIDDEN_ATTR}]`).forEach((el) => {
    const link = el as HTMLLinkElement;
    const prevMedia = link.getAttribute("data-jiff-prev-media");
    if (prevMedia === null || prevMedia === "") {
      link.removeAttribute("media");
    } else {
      link.setAttribute("media", prevMedia);
    }
    link.removeAttribute("data-jiff-prev-media");
    link.removeAttribute(HIDDEN_ATTR);
  });
}

function hideStaticFavicons() {
  document.head
    .querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')
    .forEach((el) => {
      const link = el as HTMLLinkElement;
      if (link.hasAttribute(MANAGED_ATTR)) return;
      if (link.hasAttribute(HIDDEN_ATTR)) return;
      link.setAttribute("data-jiff-prev-media", link.getAttribute("media") ?? "");
      link.setAttribute("media", "not all");
      link.setAttribute(HIDDEN_ATTR, "1");
    });
}

function appendManagedLink(attrs: Record<string, string>) {
  const link = document.createElement("link");
  link.setAttribute(MANAGED_ATTR, "1");
  for (const [k, v] of Object.entries(attrs)) {
    link.setAttribute(k, v);
  }
  document.head.appendChild(link);
}

/**
 * Apply published `shell` image placements to document favicon links.
 * Static `index.html` icons stay until a successful fetch provides at
 * least one CMS image; missing labels keep the built-in assets.
 */
export function applyShellFavicons(items: JiffContentItem[]) {
  const favicon = imageByLabel(items, "favicon");
  const faviconDark = imageByLabel(items, "favicon_dark");
  const apple = imageByLabel(items, "apple_touch_icon") ?? favicon;

  clearManagedFavicons();

  if (!favicon && !faviconDark && !imageByLabel(items, "apple_touch_icon")) {
    restoreStaticFavicons();
    return;
  }

  hideStaticFavicons();

  if (favicon) {
    appendManagedLink({
      rel: "icon",
      type: guessImageMime(favicon.url),
      href: favicon.url,
    });
    // Cover common sizes browsers look for when no SVG is provided.
    appendManagedLink({
      rel: "icon",
      type: guessImageMime(favicon.url),
      sizes: "32x32",
      href: favicon.url,
    });
    appendManagedLink({
      rel: "icon",
      type: guessImageMime(favicon.url),
      sizes: "16x16",
      href: favicon.url,
    });
  }

  if (faviconDark) {
    appendManagedLink({
      rel: "icon",
      type: guessImageMime(faviconDark.url),
      sizes: "32x32",
      href: faviconDark.url,
      media: "(prefers-color-scheme: dark)",
    });
    appendManagedLink({
      rel: "icon",
      type: guessImageMime(faviconDark.url),
      sizes: "16x16",
      href: faviconDark.url,
      media: "(prefers-color-scheme: dark)",
    });
  }

  if (apple) {
    appendManagedLink({
      rel: "apple-touch-icon",
      sizes: "180x180",
      href: apple.url,
    });
  }
}

/**
 * Zero-DOM helper: swaps favicons from JiffContent `shell` images after
 * a successful published fetch. Does not touch the head while the
 * request is pending or failed (keeps index.html defaults).
 */
export function DocumentFaviconSync() {
  const cms = useJiffPageContent("shell");

  useEffect(() => {
    if (!cms.isSuccess) return;
    applyShellFavicons(cms.data ?? []);
  }, [cms.isSuccess, cms.data]);

  return null;
}
