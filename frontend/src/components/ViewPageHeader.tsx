import type { ReactNode } from "react";
import { useTabLabels } from "../lib/queries";
import { cn } from "../lib/cn";
import {
  parentNavDropdownForTab,
  TAB_PAGE_DESCRIPTIONS,
  type TabLabelKey,
} from "../lib/navTabs";

/**
 * Uniform page header for every main nav view. Shows the active tab
 * title plus its parent dropdown label (Plan, Queues, Reference) so
 * dropdown-nav destinations are obvious at a glance.
 */
export function ViewPageHeader({
  tabKey,
  description,
  actions,
  className,
}: {
  tabKey: TabLabelKey;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  const tabLabels = useTabLabels();
  const title = tabLabels[tabKey];
  const parent = parentNavDropdownForTab(tabKey);
  const subtitle = description ?? TAB_PAGE_DESCRIPTIONS[tabKey];

  return (
    <header
      className={cn(
        "shrink-0 border-b border-wp-stone bg-white px-5 py-3",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {parent ? (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-wp-red">
              {parent.menuLabel}
            </p>
          ) : null}
          <h1 className={cn("text-xl font-semibold text-wp-ink", parent && "mt-0.5")}>
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1 text-sm text-wp-slate">{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}
