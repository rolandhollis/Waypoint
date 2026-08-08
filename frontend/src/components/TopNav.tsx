import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  ChevronDown,
  Layers,
  ListOrdered,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useIsAdmin, useTabLabels } from "../lib/queries";
import { cn } from "../lib/cn";
import {
  isNavDropdownGroupActive,
  isNavPathActive,
  NAV_DROPDOWN_GROUPS,
  PRIMARY_NAV_KEYS,
  TAB_ROUTES,
  type NavDropdownGroup,
  type TabLabelKey,
} from "../lib/navTabs";
import { ChessKnightIcon } from "./ChessKnightIcon";

const DROPDOWN_ICONS: Record<string, LucideIcon> = {
  plan: ListOrdered,
  queues: Layers,
  reference: BookOpen,
};

const DROPDOWN_CONTENT_CLASS =
  "z-50 min-w-[11rem] rounded-md border border-wp-stone bg-white p-1 shadow-md";
const DROPDOWN_ITEM_CLASS =
  "block rounded-md px-3 py-1.5 text-sm font-medium text-wp-slate outline-none hover:bg-wp-stone/40 hover:text-wp-ink data-[highlighted]:bg-wp-stone/40 data-[highlighted]:text-wp-ink";

function primaryNavClass(active: boolean) {
  return cn(
    "rounded-md px-3 py-1.5 text-sm font-medium transition",
    active ? "bg-wp-red text-white" : "text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink",
  );
}

function dropdownTriggerClass(active: boolean) {
  return cn(
    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition outline-none",
    active
      ? "border-wp-red bg-wp-red text-white shadow-sm"
      : "border-wp-stone bg-wp-stone/25 text-wp-slate hover:border-wp-stone hover:bg-wp-stone/45 hover:text-wp-ink",
  );
}

function NavTabLink({ to, label, active }: { to: string; label: string; active: boolean }) {
  return (
    <NavLink to={to} className={primaryNavClass(active)}>
      {label}
    </NavLink>
  );
}

function NavDropdown({
  group,
  tabLabels,
  pathname,
}: {
  group: NavDropdownGroup;
  tabLabels: Record<TabLabelKey, string>;
  pathname: string;
}) {
  const active = isNavDropdownGroupActive(pathname, group);
  const Icon = DROPDOWN_ICONS[group.id] ?? ListOrdered;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={dropdownTriggerClass(active)}>
        <Icon size={15} className={cn("shrink-0", active ? "text-white" : "text-wp-red/90")} />
        {group.menuLabel}
        <ChevronDown
          size={14}
          className={cn("shrink-0 transition", active ? "text-white/90" : "text-wp-slate/70")}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content sideOffset={6} align="start" className={DROPDOWN_CONTENT_CLASS}>
          {group.sections.flatMap((section) =>
            section.keys.map((key) => {
              const to = TAB_ROUTES[key];
              const itemActive = isNavPathActive(pathname, to);
              return (
                <DropdownMenu.Item key={key} asChild>
                  <NavLink
                    to={to}
                    className={cn(DROPDOWN_ITEM_CLASS, itemActive && "bg-wp-red/10 text-wp-ink")}
                  >
                    {tabLabels[key]}
                  </NavLink>
                </DropdownMenu.Item>
              );
            }),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function NavIconLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1.5 transition",
        active
          ? "bg-wp-red text-white"
          : "text-wp-slate hover:bg-wp-stone/40 hover:text-wp-ink",
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </NavLink>
  );
}

export function TopNav() {
  const location = useLocation();
  const pathname = location.pathname;
  const tabLabels = useTabLabels();
  const isAdmin = useIsAdmin();

  return (
    <nav className="flex items-center gap-1.5">
      {PRIMARY_NAV_KEYS.map((key) => (
        <NavTabLink
          key={key}
          to={TAB_ROUTES[key]}
          label={tabLabels[key]}
          active={isNavPathActive(pathname, TAB_ROUTES[key])}
        />
      ))}
      {NAV_DROPDOWN_GROUPS.map((group) => (
        <NavDropdown
          key={group.id}
          group={group}
          tabLabels={tabLabels}
          pathname={pathname}
        />
      ))}
      <NavIconLink
        to={TAB_ROUTES.game}
        label={tabLabels.game}
        active={isNavPathActive(pathname, TAB_ROUTES.game)}
      >
        <ChessKnightIcon
          size={18}
          className={cn(
            isNavPathActive(pathname, TAB_ROUTES.game) ? "text-white" : "text-wp-red/90",
          )}
        />
      </NavIconLink>
      {isAdmin ? (
        <NavTabLink
          to={TAB_ROUTES.admin}
          label={tabLabels.admin}
          active={isNavPathActive(pathname, TAB_ROUTES.admin)}
        />
      ) : null}
    </nav>
  );
}
