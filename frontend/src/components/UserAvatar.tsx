import { forwardRef, type ButtonHTMLAttributes } from "react";
import { readableOn } from "../lib/colors";
import { cn } from "../lib/cn";

/**
 * Small circular avatar showing a user's initials. Background is
 * the user's assigned `color` at full saturation; foreground is
 * picked at render time via `readableOn()` — that helper switches
 * between white and wp-ink based on the actual luminance of the
 * background, which is what a solid-fill circle needs (unlike the
 * light-tint team pills elsewhere in the app, which use
 * `pillTextColor` to get a darkened team-hue on their pale-tint
 * background — see `frontend/src/lib/colors.ts`).
 *
 * The initials rule matches the existing convention used in
 * `ProjectComments`: first letters of the first + last space-
 * separated tokens; a single-word name uses the first two
 * letters (so "Cher" reads as "CH" rather than a lonely "C").
 * Falls back to `?` on an empty/whitespace-only name so a partial
 * roster fetch never renders a blank bubble.
 *
 * `size` is a diameter in pixels — 28 by default (matches the
 * spec for the navbar bubble); the font sizing tracks the
 * diameter so a big popover-row avatar and a small navbar avatar
 * both keep the initials proportionally readable.
 *
 * The component renders as a `<button>` when an `onClick` is
 * supplied so the navbar avatar can act as a menu trigger; when
 * only `name` + `color` are supplied it renders as a plain
 * `<span>` (used inside NotificationsMenu rows where the outer
 * button already handles the click).
 */
export type UserAvatarProps = {
  name: string;
  color: string;
  size?: number;
  className?: string;
  title?: string;
};

export const UserAvatar = forwardRef<HTMLSpanElement, UserAvatarProps>(
  function UserAvatar({ name, color, size = 28, className, title }, ref) {
    const bg = color || "#64748B";
    const fg = readableOn(bg);
    const initials = deriveInitials(name);
    // Font-size heuristic: initials should fit comfortably inside
    // the circle regardless of diameter. 40% of the diameter puts
    // 28px avatars at ~11px letters (matches the current
    // ProjectComments 5×5 rem-2.5 chip) and 40px avatars at ~16px.
    const fontPx = Math.max(9, Math.round(size * 0.4));
    return (
      <span
        ref={ref}
        aria-hidden={title ? undefined : false}
        title={title ?? name}
        className={cn(
          "inline-flex select-none items-center justify-center rounded-full font-semibold uppercase leading-none",
          className,
        )}
        style={{
          width: size,
          height: size,
          minWidth: size,
          minHeight: size,
          background: bg,
          color: fg,
          fontSize: fontPx,
        }}
      >
        {initials}
      </span>
    );
  },
);

/**
 * Button-shaped avatar for use as a trigger (navbar). Wraps the
 * span-shaped `UserAvatar` in a `<button>` so it can be focused,
 * clicked, and receive keyboard events without losing the semantic
 * "this is an avatar" reading on assistive tech. Consumers pass
 * standard `<button>` props (aria-*, onClick, disabled, …).
 *
 * The optional `unreadCount` renders a small red overlay in the
 * top-right corner — matches the "unread badge" spec: shows the
 * count (up to 9) or `9+` beyond that; a bare dot when the count
 * is 0 is intentionally suppressed because it would draw the eye
 * without conveying anything actionable.
 */
export type UserAvatarButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  name: string;
  color: string;
  size?: number;
  unreadCount?: number;
};

export const UserAvatarButton = forwardRef<
  HTMLButtonElement,
  UserAvatarButtonProps
>(function UserAvatarButton(
  { name, color, size = 28, unreadCount, className, ...rest },
  ref,
) {
  const hasUnread = (unreadCount ?? 0) > 0;
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      className={cn(
        // Sit above the badge in the stacking context so the
        // focus ring wraps both. `relative` anchors the badge.
        "relative inline-flex shrink-0 items-center justify-center rounded-full transition hover:ring-2 hover:ring-wp-red/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-wp-red/50",
        className,
      )}
      {...rest}
    >
      <UserAvatar name={name} color={color} size={size} />
      {hasUnread ? (
        <UnreadBadge count={unreadCount ?? 0} avatarSize={size} />
      ) : null}
    </button>
  );
});

/**
 * Red pill overlaid on the top-right of the avatar when the user
 * has unread mentions. Renders a count when < 10 and `9+`
 * beyond that so the badge stays at most two characters wide —
 * a three-character `10+` (or worse, actual counts) breaks the
 * pill layout and doesn't add useful information for the reader.
 *
 * The dot is sized as a fraction of the avatar diameter so it
 * stays visually proportional across every callsite.
 */
function UnreadBadge({ count, avatarSize }: { count: number; avatarSize: number }) {
  const label = count < 10 ? String(count) : "9+";
  const height = Math.max(12, Math.round(avatarSize * 0.55));
  const fontPx = Math.max(9, Math.round(avatarSize * 0.32));
  return (
    <span
      aria-label={`${count} unread ${count === 1 ? "mention" : "mentions"}`}
      className="pointer-events-none absolute -right-1 -top-1 inline-flex items-center justify-center rounded-full border-2 border-white bg-wp-red font-semibold text-white tabular-nums"
      style={{
        minWidth: height,
        height,
        padding: "0 4px",
        fontSize: fontPx,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}

/**
 * "Roland Hollis" → "RH". Single-token names ("Cher") take the
 * first two letters ("CH") so the bubble never looks half-empty.
 * Whitespace-only / empty inputs return `?` so a partial roster
 * fetch renders something rather than an invisible bubble.
 */
export function deriveInitials(name: string): string {
  const tokens = (name ?? "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return "?";
  if (tokens.length === 1) {
    const only = tokens[0]!;
    return (only.slice(0, 2) || only[0] || "?").toUpperCase();
  }
  const first = tokens[0]![0] ?? "";
  const last = tokens[tokens.length - 1]![0] ?? "";
  return `${first}${last}`.toUpperCase();
}
