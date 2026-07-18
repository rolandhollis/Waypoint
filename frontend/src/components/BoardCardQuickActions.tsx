import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpToLine,
  Inbox,
  MoreVertical,
} from "lucide-react";
import { forwardRef, useImperativeHandle, useState, type ReactNode } from "react";

/**
 * Imperative handle exposed to parents so a right-click on the enclosing
 * card can open the same menu, anchored to the pointer position instead
 * of the ⋮ trigger button.
 */
export type BoardCardQuickActionsHandle = {
  openAt: (x: number, y: number) => void;
};

export type BoardCardQuickActionsProps = {
  isAtTop: boolean;
  isAtBottom: boolean;
  /**
   * When false the "Move to Parking Lot" row is HIDDEN entirely — both
   * "no such lane in this tenant" and "card is already parked" collapse
   * to the same signal (nothing useful to offer).
   */
  canMoveToParkingLot: boolean;
  /**
   * When false the "Archive" row is still rendered but disabled — either
   * because no archive lane is configured (edge case admins can fix) or
   * because the card already lives in the archive lane.
   */
  canArchive: boolean;
  onMoveToTop: () => void;
  onMoveToBottom: () => void;
  onMoveToParkingLot: () => void;
  onArchive: () => void;
};

const CONTENT_CLASS =
  "z-50 min-w-[11rem] rounded-md border border-wp-stone bg-white p-1 text-sm shadow-md";
const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-wp-ink outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 hover:bg-wp-stone/40 data-[highlighted]:bg-wp-stone/40";

/**
 * Board-card quick actions menu. Renders a small ⋮ trigger and (via the
 * imperative `openAt` handle) can also be opened at an arbitrary pointer
 * position for the right-click power-user flow.
 *
 * Two Radix `DropdownMenu.Root` instances share the same items:
 *   1. Anchored to the ⋮ button — standard Radix positioning.
 *   2. Anchored to an invisible 0x0 span, `position: fixed` at the
 *      pointer coordinates supplied by the parent's onContextMenu.
 *
 * Two roots keeps each anchor's positioning logic simple and
 * independent — Radix computes coords from the trigger's bounding rect,
 * so we just move the trigger and let Radix do the rest.
 */
export const BoardCardQuickActions = forwardRef<
  BoardCardQuickActionsHandle,
  BoardCardQuickActionsProps
>(function BoardCardQuickActions(
  {
    isAtTop,
    isAtBottom,
    canMoveToParkingLot,
    canArchive,
    onMoveToTop,
    onMoveToBottom,
    onMoveToParkingLot,
    onArchive,
  },
  ref,
) {
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [pointerOpen, setPointerOpen] = useState(false);
  // Kept in state (not a ref) so setting it triggers a re-render that
  // moves the invisible anchor BEFORE Radix reads its bounding rect on
  // open — the state batch guarantees both changes land in the same
  // commit.
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useImperativeHandle(
    ref,
    () => ({
      openAt: (x, y) => {
        setPointer({ x, y });
        // Close the trigger-anchored menu first if it happened to be
        // open, otherwise both roots would render content simultaneously.
        setTriggerOpen(false);
        setPointerOpen(true);
      },
    }),
    [],
  );

  const items: ReactNode = (
    <>
      <DropdownMenu.Item
        disabled={isAtTop}
        onSelect={() => onMoveToTop()}
        className={ITEM_CLASS}
      >
        <ArrowUpToLine size={14} aria-hidden />
        <span>Move to top</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        disabled={isAtBottom}
        onSelect={() => onMoveToBottom()}
        className={ITEM_CLASS}
      >
        <ArrowDownToLine size={14} aria-hidden />
        <span>Move to bottom</span>
      </DropdownMenu.Item>
      {canMoveToParkingLot || canArchive ? (
        <DropdownMenu.Separator className="my-1 h-px bg-wp-stone" />
      ) : null}
      {canMoveToParkingLot ? (
        <DropdownMenu.Item
          onSelect={() => onMoveToParkingLot()}
          className={ITEM_CLASS}
        >
          <Inbox size={14} aria-hidden />
          <span>Move to Parking Lot</span>
        </DropdownMenu.Item>
      ) : null}
      <DropdownMenu.Item
        disabled={!canArchive}
        onSelect={() => onArchive()}
        className={ITEM_CLASS}
      >
        <Archive size={14} aria-hidden />
        <span>Archive</span>
      </DropdownMenu.Item>
    </>
  );

  return (
    <>
      <DropdownMenu.Root open={triggerOpen} onOpenChange={setTriggerOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Card quick actions"
            className="btn-ghost !p-1 text-wp-slate/60 hover:text-wp-ink data-[state=open]:text-wp-ink"
            // Isolate the trigger from the card's outer drag+click
            // surface: stopping pointerdown prevents the dnd-kit
            // sortable sensor from tracking movement (which would
            // otherwise start a drag), and stopping click prevents the
            // card's onClick from opening the detail panel.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className={CONTENT_CLASS}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {items}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <DropdownMenu.Root open={pointerOpen} onOpenChange={setPointerOpen}>
        <DropdownMenu.Trigger asChild>
          {/* 0x0 invisible span positioned at the click coords. Radix
              reads getBoundingClientRect on this element when opening
              the menu, so `align="start"` + sideOffset:0 lands the
              menu with its top-left corner at (x, y) — the classic
              browser context-menu placement. */}
          <span
            aria-hidden
            style={{
              position: "fixed",
              top: pointer.y,
              left: pointer.x,
              width: 0,
              height: 0,
              pointerEvents: "none",
            }}
          />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            side="bottom"
            sideOffset={0}
            className={CONTENT_CLASS}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {items}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
});
