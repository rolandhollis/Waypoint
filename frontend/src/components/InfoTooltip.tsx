import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/**
 * Thin wrapper around Radix Tooltip with the styling we use across the
 * app. Callers pass the trigger children (usually a text label) and the
 * `content` string to display in the hover bubble. Passing an empty
 * string / null renders the children unwrapped so callers can drop
 * this into loops without conditional logic.
 */
export function InfoTooltip({
  children,
  content,
  side = "bottom",
  align = "start",
  maxWidthClass = "max-w-xs",
}: {
  children: ReactNode;
  content: string | null | undefined;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  maxWidthClass?: string;
}) {
  const text = (content ?? "").trim();
  if (!text) return <>{children}</>;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          className={`z-50 rounded-md border border-wp-stone bg-white px-3 py-2 text-xs leading-relaxed text-wp-ink shadow-lg ${maxWidthClass}`}
        >
          {text}
          <Tooltip.Arrow className="fill-white" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
