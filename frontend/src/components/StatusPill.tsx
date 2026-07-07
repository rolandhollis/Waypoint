import type { HealthFlag } from "../lib/types";
import { cn } from "../lib/cn";

const CLASS: Record<HealthFlag, string> = {
  red: "bg-health-red border-health-red text-white",
  yellow: "bg-health-yellow border-health-yellow text-black",
  green: "bg-health-green border-health-green text-white",
  white: "bg-white border-wp-stone text-wp-slate",
};

export function StatusPill({ flag, completed, size = "sm" }: { flag: HealthFlag; completed?: boolean; size?: "sm" | "md" }) {
  const label = flag === "white" ? "no update" : flag;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border text-[10px] font-semibold uppercase tracking-wide",
        size === "md" ? "px-2 py-0.5 text-xs" : "px-1.5 py-0.5",
        CLASS[flag],
        !completed && flag !== "white" ? "opacity-70" : "",
      )}
      title={completed ? "submitted" : "draft or not yet submitted"}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}
