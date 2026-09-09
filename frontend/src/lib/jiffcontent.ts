import { useQuery } from "@tanstack/react-query";
import { useJcLocaleStore } from "./jcLocale";

export type JiffContentType = "raw_text" | "rich_html" | "image" | "layout";

export type JiffContentItem = {
  placement_id: string;
  page_name: string;
  content_type: JiffContentType;
  custom_labels: string[];
  content: Record<string, unknown>;
  locale?: string;
  published_at?: string;
};

export type JiffLayoutRenderMode = "html" | "component";

export type JiffLayoutBlock = {
  id: string;
  name: string;
  type: string;
  render: JiffLayoutRenderMode;
  props: Record<string, unknown>;
};

export type JiffLayoutColumn = {
  id: string;
  span: number;
  blocks: JiffLayoutBlock[];
  rows?: JiffLayoutRow[];
};

export type JiffLayoutRowBackground = {
  color?: string;
  image_url?: string;
};

export type JiffLayoutRow = {
  id: string;
  columns: JiffLayoutColumn[];
  background?: JiffLayoutRowBackground;
  width?: "full" | "contained";
  max_width?: string;
};

export type JiffLayoutDocument = {
  schema_version: number;
  grid: { columns: number };
  rows: JiffLayoutRow[];
  parameters?: Array<{ name: string; source: string; key?: string }>;
  blocks?: JiffLayoutBlock[];
};

export type JiffResolvedPage = {
  page: {
    id: string;
    name: string;
    slug: string;
    path: string;
    layout_id: string | null;
    layout_name?: string | null;
  };
  layout: {
    id: string;
    name: string;
    published: boolean;
    document: JiffLayoutDocument | null;
  } | null;
};

type JiffContentResponse = {
  data?: JiffContentItem[];
};

type JiffResolveResponse = {
  data?: JiffResolvedPage;
};

const DEFAULT_API_BASE = "https://api.jiffcontent.com";
const publicKey = (import.meta.env.VITE_JIFFCONTENT_PUBLIC_KEY as string | undefined)?.trim();
const apiBase =
  (import.meta.env.VITE_JIFFCONTENT_API_BASE as string | undefined)?.trim() || DEFAULT_API_BASE;
const homePagePath =
  (import.meta.env.VITE_JIFFCONTENT_HOME_PATH as string | undefined)?.trim() || "/";

export function isJiffContentConfigured(): boolean {
  return !!publicKey;
}

export function jiffHomePagePath(): string {
  return homePagePath.startsWith("/") ? homePagePath : `/${homePagePath}`;
}

async function fetchContentPage(pageName: string, locale: string): Promise<JiffContentItem[]> {
  if (!publicKey) return [];
  const params = new URLSearchParams({ page_name: pageName });
  if (locale) params.set("locale", locale);
  const res = await fetch(`${apiBase}/v1/content?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${publicKey}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`JiffContent fetch failed (${res.status}): ${body || res.statusText}`);
  }
  const json = (await res.json()) as JiffContentResponse;
  return json.data ?? [];
}

function normalizeLayoutDocument(
  doc: JiffLayoutDocument | null | undefined,
): JiffLayoutDocument | null {
  if (!doc) return null;
  if (Array.isArray(doc.rows) && doc.grid?.columns) {
    return {
      ...doc,
      parameters: Array.isArray(doc.parameters) ? doc.parameters : [],
    };
  }
  const blocks = doc.blocks ?? [];
  return {
    schema_version: 2,
    grid: { columns: 12 },
    rows: [{ id: "row_legacy", columns: [{ id: "col_legacy", span: 12, blocks }] }],
    parameters: [],
  };
}

async function resolvePublishedPage(
  path: string,
  locale: string,
): Promise<JiffResolvedPage | null> {
  if (!publicKey) return null;
  const params = new URLSearchParams({ path });
  if (locale) params.set("locale", locale);
  const res = await fetch(`${apiBase}/v1/pages/resolve?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${publicKey}`,
      Accept: "application/json",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`JiffContent page resolve failed (${res.status}): ${body || res.statusText}`);
  }
  const json = (await res.json()) as JiffResolveResponse;
  const data = json.data;
  if (!data?.page) return null;
  return {
    page: data.page,
    layout: data.layout
      ? {
          ...data.layout,
          document: normalizeLayoutDocument(data.layout.document),
        }
      : null,
  };
}

export function useJiffPageContent(pageName: string) {
  const locale = useJcLocaleStore((s) => s.locale);
  return useQuery({
    queryKey: ["jiffcontent", "page", pageName, locale],
    queryFn: () => fetchContentPage(pageName, locale),
    enabled: !!publicKey,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/** Resolve a published site page + layout by URL path (e.g. `/`). */
export function useJiffResolvedPage(path: string) {
  const locale = useJcLocaleStore((s) => s.locale);
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return useQuery({
    queryKey: ["jiffcontent", "resolve", normalized, locale],
    queryFn: () => resolvePublishedPage(normalized, locale),
    enabled: !!publicKey,
    staleTime: 60_000,
    // No refetchInterval: a background swap from built-in/error → layout
    // (or old layout → new) reads as homepage flicker.
    retry: 2,
  });
}

/** Published layout document from a resolve result, if any. */
export function publishedLayoutDocument(
  resolved: JiffResolvedPage | null | undefined,
): JiffLayoutDocument | null {
  const layout = resolved?.layout;
  if (!layout?.published) return null;
  return layout.document ?? null;
}

export function placementByLabel(items: JiffContentItem[], label: string): JiffContentItem | undefined {
  return items.find((i) => i.custom_labels?.includes(label));
}

export function rawTextByLabel(items: JiffContentItem[], label: string): string | null {
  const item = placementByLabel(items, label);
  const value = item?.content?.text;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function imageByLabel(
  items: JiffContentItem[],
  label: string,
): { url: string; alt: string } | null {
  const item = placementByLabel(items, label);
  if (!item || item.content_type !== "image") return null;
  const url = String(item.content?.url ?? "").trim();
  if (!url) return null;
  const alt = String(item.content?.alt_text ?? "").trim() || "Image";
  return { url, alt };
}

export function boolFromText(text: string | null | undefined, fallback: boolean): boolean {
  if (!text) return fallback;
  const key = text.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(key)) return true;
  if (["0", "false", "no", "n", "off"].includes(key)) return false;
  return fallback;
}
