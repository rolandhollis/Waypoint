import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { HealthFlag } from "../lib/types";
import { cn } from "../lib/cn";

/**
 * Custom health-flag picker. Each option renders its swatch alongside the
 * label so the color is visible both in the closed trigger and inside the
 * open menu. Empty string represents "no selection" (placeholder state).
 */
type Option = {
  value: Exclude<HealthFlag, "white">;
  label: string;
  swatch: string;
};

const OPTIONS: Option[] = [
  { value: "green",  label: "Green",  swatch: "bg-health-green" },
  { value: "yellow", label: "Yellow", swatch: "bg-health-yellow" },
  { value: "red",    label: "Red",    swatch: "bg-health-red" },
];

export function HealthFlagSelect({
  value,
  onChange,
  className,
  triggerWidthClass = "w-40",
  autoFocus,
  ariaLabel = "Health flag",
}: {
  value: HealthFlag | "";
  onChange: (next: HealthFlag | "") => void;
  className?: string;
  triggerWidthClass?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const selected = OPTIONS.find((o) => o.value === value);

  return (
    <Select.Root
      value={value || undefined}
      onValueChange={(v) => onChange(v as HealthFlag)}
    >
      <Select.Trigger
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        className={cn(
          "input inline-flex items-center justify-between gap-2 text-left",
          triggerWidthClass,
          className,
        )}
      >
        <Select.Value asChild>
          <span className="inline-flex min-w-0 items-center gap-2">
            {selected ? (
              <>
                <Swatch className={selected.swatch} />
                <span className="truncate text-wp-ink">{selected.label}</span>
              </>
            ) : (
              <span className="text-wp-slate">— Choose —</span>
            )}
          </span>
        </Select.Value>
        <Select.Icon>
          <ChevronDown size={14} className="text-wp-slate" />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[10rem] overflow-hidden rounded-md border border-wp-stone bg-white shadow-lg"
        >
          <Select.Viewport className="p-1">
            {OPTIONS.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-wp-ink outline-none data-[highlighted]:bg-wp-stone/60 data-[state=checked]:font-medium"
              >
                <Swatch className={o.swatch} />
                <Select.ItemText>{o.label}</Select.ItemText>
                <Select.ItemIndicator className="ml-auto text-wp-slate">
                  <Check size={12} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function Swatch({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10",
        className,
      )}
    />
  );
}
