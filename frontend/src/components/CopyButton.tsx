import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Copy-to-clipboard button. Uses the modern Clipboard API and falls
 * back to a hidden textarea + execCommand for browsers that block
 * writeText in non-secure contexts (e.g. plain-HTTP local dev on
 * legacy Safari). The "Copied!" affordance is visible for 1.5s.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied!",
  className,
  onCopy,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  onCopy?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timeout.current) clearTimeout(timeout.current);
  }, []);

  const doCopy = useCallback(async () => {
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(true);
    onCopy?.();
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setCopied(false), 1500);
  }, [value, onCopy]);

  return (
    <button
      type="button"
      onClick={doCopy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
        copied
          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
          : "border-wp-stone bg-white text-wp-ink hover:bg-wp-stone/30",
        className,
      )}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? copiedLabel : label}
    </button>
  );
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
