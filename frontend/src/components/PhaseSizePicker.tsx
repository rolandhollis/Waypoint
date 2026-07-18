import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import { useCanWrite } from "../lib/queries";
import type { TshirtSize } from "../lib/types";
import { cn } from "../lib/cn";

export type PhaseSizePickerProps = {
  /** Human-readable phase name for the trigger's aria-label
   *  ("Discovery size", "Development size", …). */
  phaseLabel: string;
  /** Current phase length in days, or null when either the phase
   *  start or end (or both) is unset. Null renders "-" on the
   *  trigger. */
  currentDays: number | null;
  /** Admin-managed size ladder (S/M/L/XL/XXL by default). Loaded
   *  once at the view level and passed down so every row shares the
   *  same picker instance's config. */
  sizes: TshirtSize[] | undefined;
  /** Fires with the chosen day count. Cascade logic lives in the
   *  parent — the picker itself is stateless. */
  onPickSize: (days: number) => void;
};

const CONTENT_CLASS =
  "z-50 min-w-[10rem] rounded-md border border-wp-stone bg-white p-1 text-xs shadow-md";
const ITEM_CLASS =
  "flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-wp-ink outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 hover:bg-wp-stone/40 data-[highlighted]:bg-wp-stone/40";

/**
 * T-shirt size picker for a single phase (Discovery / Development /
 * Post-Dev). Trigger shows the CURRENT phase length in days, or "-"
 * when either bound is unset. Dropdown offers the current length as
 * the leading option (so the user always sees what's really set),
 * a separator, then the S/M/L/XL/XXL presets pulled from
 * `sizes` — no hardcoded day counts here, the admin controls the
 * ladder in Admin → T-Shirt Sizes.
 *
 * Viewers see the trigger disabled; the picker never fires an
 * onPickSize from a role that can't persist the mutation.
 */
export function PhaseSizePicker({
  phaseLabel,
  currentDays,
  sizes,
  onPickSize,
}: PhaseSizePickerProps) {
  const canWrite = useCanWrite();
  const disabled = !canWrite;

  // Match the current length to a preset (by day count) so the
  // trigger can badge the letter when one lines up. Purely a visual
  // affordance — the dropdown still lists the current length as the
  // first row regardless.
  const matchingPreset =
    currentDays != null
      ? (sizes ?? []).find((s) => s.days === currentDays) ?? null
      : null;

  const triggerLabel =
    currentDays == null ? "-" : `${currentDays}d`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`${phaseLabel} size`}
          disabled={disabled}
          className={cn(
            "inline-flex min-w-[6rem] items-center justify-between gap-1 rounded-md border border-wp-stone bg-white px-2 py-1 text-xs text-wp-ink transition",
            !disabled && "hover:bg-wp-stone/30 data-[state=open]:bg-wp-stone/40",
            disabled && "cursor-not-allowed opacity-50",
          )}
          title={
            disabled
              ? "Viewer role — read-only"
              : `${phaseLabel}: ${
                  currentDays == null ? "no dates set" : `${currentDays} days`
                }`
          }
        >
          <span className="flex items-baseline gap-1 tabular-nums">
            {triggerLabel}
            {matchingPreset ? (
              <span className="text-[10px] uppercase tracking-wide text-wp-slate/70">
                · {matchingPreset.label}
              </span>
            ) : null}
          </span>
          <ChevronDown size={12} className="shrink-0 text-wp-slate/70" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={CONTENT_CLASS}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {/* Current length row — always present when a length
              exists, even if it happens to match a preset. Gives the
              PM a visual anchor of "what is set right now" before
              they change it. */}
          {currentDays != null ? (
            <>
              <DropdownMenu.Item
                onSelect={() => onPickSize(currentDays)}
                className={ITEM_CLASS}
              >
                <span>Current</span>
                <span className="tabular-nums text-wp-slate">
                  {currentDays} days
                </span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-wp-stone" />
            </>
          ) : null}
          {(sizes ?? []).map((s) => (
            <DropdownMenu.Item
              key={s.id}
              onSelect={() => onPickSize(s.days)}
              className={ITEM_CLASS}
            >
              <span className="font-medium">{s.label}</span>
              <span className="tabular-nums text-wp-slate">· {s.days} days</span>
            </DropdownMenu.Item>
          ))}
          {(sizes ?? []).length === 0 ? (
            <div className="px-2 py-1 text-wp-slate">No sizes configured.</div>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
