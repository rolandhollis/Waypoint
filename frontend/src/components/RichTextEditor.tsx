import { Bold, Italic, Underline } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Tailwind min-height class, e.g. min-h-[8rem] */
  minHeightClass?: string;
  className?: string;
  "aria-label"?: string;
};

/** True when HTML has no visible text (empty editor / placeholder-only). */
export function isEmptyRichText(html: string): boolean {
  return (
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim().length === 0
  );
}

function normalizeEditorHtml(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || isEmptyRichText(trimmed)) return "";
  return trimmed;
}

/**
 * Lightweight WYSIWYG for email bodies — bold / italic / underline only.
 * Emits HTML; backend sanitizes before send.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder = "Write a message…",
  disabled = false,
  minHeightClass = "min-h-[8rem]",
  className = "",
  "aria-label": ariaLabel,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value === lastEmitted.current) return;
    if (document.activeElement === el) return;
    el.innerHTML = value || "";
    lastEmitted.current = value;
  }, [value]);

  function emit() {
    const html = normalizeEditorHtml(ref.current?.innerHTML ?? "");
    lastEmitted.current = html;
    onChange(html);
  }

  function runCommand(command: "bold" | "italic" | "underline") {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand(command, false);
    emit();
  }

  const empty = isEmptyRichText(value);

  return (
    <div
      className={
        "overflow-hidden rounded-md border border-wp-stone bg-white focus-within:border-wp-red focus-within:ring-1 focus-within:ring-wp-red " +
        (disabled ? "opacity-60 " : "") +
        className
      }
    >
      <div className="flex items-center gap-0.5 border-b border-wp-stone/70 bg-wp-stone/20 px-1.5 py-1">
        <ToolbarButton
          label="Bold"
          disabled={disabled}
          onClick={() => runCommand("bold")}
        >
          <Bold size={14} strokeWidth={2.5} />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          disabled={disabled}
          onClick={() => runCommand("italic")}
        >
          <Italic size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Underline"
          disabled={disabled}
          onClick={() => runCommand("underline")}
        >
          <Underline size={14} />
        </ToolbarButton>
      </div>
      <div className="relative">
        {empty && !disabled ? (
          <div
            className="pointer-events-none absolute left-2.5 top-1.5 text-sm text-wp-slate/60"
            aria-hidden
          >
            {placeholder}
          </div>
        ) : null}
        <div
          ref={ref}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel ?? placeholder}
          aria-disabled={disabled || undefined}
          contentEditable={!disabled}
          suppressContentEditableWarning
          className={
            "px-2.5 py-1.5 text-sm text-wp-ink outline-none " +
            minHeightClass +
            " [&_b]:font-bold [&_strong]:font-bold [&_em]:italic [&_i]:italic [&_u]:underline"
          }
          onInput={emit}
          onBlur={emit}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
              e.preventDefault();
              runCommand("bold");
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
              e.preventDefault();
              runCommand("italic");
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "u") {
              e.preventDefault();
              runCommand("underline");
            }
          }}
        />
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-wp-ink hover:bg-white disabled:opacity-40"
      onMouseDown={(e) => {
        // Keep selection in the editor
        e.preventDefault();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
