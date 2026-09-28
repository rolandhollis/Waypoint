/**
 * Allowlist sanitizer for admin-authored email HTML (announcement body,
 * digest admin note). Strips everything except a small set of inline /
 * block tags that survive common mail clients.
 */

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "div",
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "ul",
  "ol",
  "li",
]);

/** Decode a few common entities so plain-text extraction stays readable. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Strip to allowlisted tags. Attributes are removed. Unknown tags are
 * unwrapped (children kept). Script/style contents are dropped.
 */
export function sanitizeEmailHtml(input: string): string {
  const raw = input.trim();
  if (!raw) return "";

  // Drop dangerous blocks entirely.
  let html = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  // Normalize void <br> forms.
  html = html.replace(/<br\s*\/?>/gi, "<br>");

  // Walk tags: keep allowlisted open/close, strip attributes, unwrap others.
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, rawName: string) => {
    const name = rawName.toLowerCase();
    const isClose = match.startsWith("</");
    if (!ALLOWED_TAGS.has(name)) return "";
    if (name === "br") return isClose ? "" : "<br>";
    return isClose ? `</${name}>` : `<${name}>`;
  });

  // Collapse leftover empty wrappers that browsers leave behind.
  if (!htmlToPlainText(html).trim()) return "";
  return html;
}

/** HTML → plain text for the multipart text/plain part. */
export function htmlToPlainText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li)\s*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "• ");
  const stripped = withBreaks.replace(/<[^>]+>/g, "");
  return decodeEntities(stripped)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Prefer sanitized rich HTML when the payload looks like HTML; otherwise
 * treat as plain text and wrap paragraphs (legacy plain notes).
 */
export function emailBodyToHtml(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    return sanitizeEmailHtml(trimmed);
  }
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 12px;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

export function emailBodyToPlainText(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    return htmlToPlainText(sanitizeEmailHtml(trimmed));
  }
  return trimmed;
}
