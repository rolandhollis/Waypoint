import { useLayoutEffect, useRef } from "react";

/**
 * Mounts PM-authored HTML into the DOM, including `<style>` and `<script>`.
 * Scripts inserted via innerHTML do not run, so we re-create them after mount.
 * Uses layout effect so content is in the DOM before paint (avoids empty flash).
 */
export function AbAuthoredHtml({
  html,
  className,
}: {
  html: string;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    root.innerHTML = html;

    const scripts = Array.from(root.querySelectorAll("script"));
    for (const oldScript of scripts) {
      const next = document.createElement("script");
      for (const attr of oldScript.attributes) {
        next.setAttribute(attr.name, attr.value);
      }
      if (oldScript.textContent) {
        next.text = oldScript.textContent;
      }
      oldScript.replaceWith(next);
    }
    // Do not clear on cleanup — Strict Mode remounts would flash empty.
  }, [html]);

  return <div ref={rootRef} className={className} />;
}
