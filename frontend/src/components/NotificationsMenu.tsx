import * as Popover from "@radix-ui/react-popover";
import { formatDistanceToNowStrict } from "date-fns";
import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LogOut, User as UserIcon } from "lucide-react";
import {
  useMarkMentionRead,
  useRecentMentions,
  useUnreadMentionCount,
  useMe,
  type MentionRow,
} from "../lib/queries";
import { cn } from "../lib/cn";
import { UserAvatar, UserAvatarButton } from "./UserAvatar";

/**
 * Click-triggered notifications popover anchored on the navbar
 * user-avatar. Opens on avatar click; stays open until the user
 * clicks outside, presses Escape, picks a mention, or uses a
 * footer action (Profile / Sign out).
 *
 * Renders the current user's latest 10 mentions; clicking a row
 * deep-links to `/projects/<id>#comment-<id>` (or `#description`),
 * marks the mention read, and closes the popover so the target
 * page's anchor scroll + highlight can run cleanly.
 *
 * Footer also carries Profile (`/profile`) and, in password mode,
 * Sign out — so the avatar is the ONE navbar control for identity
 * + notifications. The parent (`UserSwitcher`) supplies logout.
 *
 * Data: unread-count polls in the background for the badge; the
 * recent-list query only fires while `open` so we don't pay the
 * join cost on every page.
 */
export type NotificationsMenuProps = {
  /** Provided only in password mode where a client-side logout makes sense. */
  onSignOut?: (() => void) | null;
  /** Disables the sign-out button while its mutation is in flight. */
  signOutBusy?: boolean;
};

export function NotificationsMenu({
  onSignOut,
  signOutBusy,
}: NotificationsMenuProps) {
  const me = useMe();
  const [open, setOpen] = useState(false);

  // Background poll for the badge. Runs whether the popover is
  // open or closed so a fresh mention shows up in the navbar
  // within one MENTION_POLL_MS tick regardless of whether the
  // user has interacted.
  const unread = useUnreadMentionCount(!!me.data);
  const recent = useRecentMentions(open, 10);
  const markRead = useMarkMentionRead();
  const navigate = useNavigate();

  const handleRowClick = useCallback(
    (row: MentionRow) => {
      const hash =
        row.source_type === "comment" && row.source_id
          ? `#comment-${row.source_id}`
          : "#description";
      // Mark-read is fire-and-forget — the invalidation on
      // success flips the badge / list without us awaiting it,
      // and a hiccup shouldn't block navigation.
      if (!row.read_at) markRead.mutate(row.id);
      setOpen(false);
      navigate(`/projects/${row.project_id}${hash}`);
    },
    [markRead, navigate],
  );

  // Nothing to render before /users/me lands — the parent
  // (`UserSwitcher`) already gates this component behind the
  // same condition, but we keep the guard so the hooks above
  // stay defensively no-op when called with `enabled=false`.
  if (!me.data) return null;
  const user = me.data;
  const unreadCount = unread.data?.count ?? 0;
  const rows = recent.data ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <UserAvatarButton
          name={user.name}
          color={user.color}
          size={28}
          unreadCount={unreadCount}
          aria-label={
            unreadCount > 0
              ? `Notifications — ${unreadCount} unread`
              : "Notifications"
          }
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[22rem] rounded-md border border-wp-stone bg-white p-0 shadow-lg outline-none"
        >
          <div className="flex items-center justify-between border-b border-wp-stone px-3 py-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
                Notifications
              </h4>
              {unreadCount > 0 ? (
                <span className="text-[11px] font-medium text-wp-red">
                  {unreadCount} unread
                </span>
              ) : null}
            </div>
            <span className="truncate text-[11px] text-wp-slate" title={user.email}>
              {user.name}
            </span>
          </div>
          <div className="max-h-[24rem] overflow-y-auto">
            {recent.isLoading && rows.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-wp-slate">
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-wp-slate">
                No mentions yet. Teammates will show up here when they
                <br />
                @mention you on a comment or description.
              </div>
            ) : (
              <ul className="divide-y divide-wp-stone/70">
                {rows.map((row) => (
                  <MentionRowItem
                    key={row.id}
                    row={row}
                    onClick={() => handleRowClick(row)}
                  />
                ))}
              </ul>
            )}
          </div>
          {rows.length >= 10 ? (
            // "See all" stub — there's no dedicated notifications
            // view yet, so the link points at nothing useful; keep
            // the row so the affordance is discoverable and the
            // future page can wire itself in without a layout
            // change. When the page exists this becomes a proper
            // `<Link to="/notifications">…</Link>`.
            <div className="border-t border-wp-stone px-3 py-2 text-center text-[11px] text-wp-slate">
              Showing the 10 most recent. (Full inbox view coming soon.)
            </div>
          ) : null}
          {/* Footer actions: profile + sign out. Sits inside the
              popover so the avatar is the ONE navbar control for
              identity + notifications. Sign-out is only wired in
              password mode — the other auth modes (mock / okta /
              cf-access) have no meaningful client-side logout. */}
          <div className="flex items-center justify-between border-t border-wp-stone bg-wp-bg/40 px-3 py-2">
            <Link
              to="/profile"
              className="inline-flex items-center gap-1.5 text-xs text-wp-slate transition hover:text-wp-ink focus:text-wp-ink focus:outline-none"
              onClick={() => setOpen(false)}
            >
              <UserIcon size={12} />
              Profile
            </Link>
            {onSignOut ? (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-wp-slate transition hover:text-wp-ink focus:text-wp-ink focus:outline-none disabled:opacity-60"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
                disabled={!!signOutBusy}
              >
                <LogOut size={12} />
                {signOutBusy ? "Signing out\u2026" : "Sign out"}
              </button>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MentionRowItem({
  row,
  onClick,
}: {
  row: MentionRow;
  onClick: () => void;
}) {
  const relative = formatRelative(row.created_at);
  const context =
    row.source_type === "comment" ? "commented on" : "updated the description of";
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2.5 text-left transition hover:bg-wp-stone/40 focus:bg-wp-stone/40 focus:outline-none",
          !row.read_at ? "bg-wp-red/[0.04]" : "",
        )}
      >
        <UserAvatar
          name={row.mentioning_user.name}
          color={row.mentioning_user.color}
          size={26}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-wp-ink">
              <span className="font-medium">{row.mentioning_user.name}</span>{" "}
              <span className="text-wp-slate">{context}</span>{" "}
              <span className="font-medium text-wp-ink">{row.project_title}</span>
            </span>
            <span
              className="shrink-0 text-[11px] text-wp-slate"
              title={new Date(row.created_at).toLocaleString()}
            >
              {relative}
            </span>
          </div>
          {row.snippet ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-wp-slate">
              {row.snippet}
            </p>
          ) : null}
        </div>
        {!row.read_at ? (
          <span
            aria-hidden
            className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-wp-red"
          />
        ) : null}
      </button>
    </li>
  );
}

/**
 * "2h ago" / "5m ago" — short relative timestamp. `date-fns`
 * returns e.g. "2 hours" so we suffix "ago" ourselves. Falls back
 * to "just now" for sub-minute values so a fresh mention doesn't
 * read as "0 seconds ago".
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";
  return `${formatDistanceToNowStrict(new Date(iso), { addSuffix: false })} ago`;
}
