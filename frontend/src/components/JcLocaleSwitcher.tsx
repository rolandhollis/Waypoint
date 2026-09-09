import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "../lib/cn";
import { JC_LOCALES, useJcLocaleStore } from "../lib/jcLocale";

/**
 * Navbar control for JiffContent locale (en / fr / es).
 * Changing locale invalidates JC queries so placements + layouts refetch.
 */
export function JcLocaleSwitcher() {
  const locale = useJcLocaleStore((s) => s.locale);
  const setLocale = useJcLocaleStore((s) => s.setLocale);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = JC_LOCALES.find((l) => l.code === locale) ?? JC_LOCALES[0];

  function pick(code: string) {
    setLocale(code);
    setOpen(false);
    void qc.invalidateQueries({ queryKey: ["jiffcontent"] });
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border border-wp-stone bg-white px-2.5 py-1.5 text-sm font-medium text-wp-ink hover:bg-wp-stone/30"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Content language"
        title="Content language"
      >
        <span className="uppercase tracking-wide text-wp-slate">{current.code}</span>
        <span className="max-w-[100px] truncate">{current.label}</span>
        <svg
          viewBox="0 0 12 12"
          className={cn("h-3 w-3 text-wp-slate transition", open && "rotate-180")}
          aria-hidden
        >
          <path
            d="M2 4l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-wp-stone bg-white py-1 shadow-lg"
        >
          {JC_LOCALES.map((opt) => (
            <button
              key={opt.code}
              type="button"
              role="menuitemradio"
              aria-checked={opt.code === locale}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-wp-stone/40",
                opt.code === locale ? "font-semibold text-wp-ink" : "text-wp-slate",
              )}
              onClick={() => pick(opt.code)}
            >
              <span className="w-6 uppercase tracking-wide">{opt.code}</span>
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
