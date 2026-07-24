import * as Dialog from "@radix-ui/react-dialog";
import { ProjectDetailBody } from "./ProjectDetailBody";

/**
 * Right-side modal wrapper around `ProjectDetailBody`. This file is
 * intentionally thin — every affordance (title, dates, comments,
 * subtasks, audit trail, sibling nav, star toggle, dates lock, AI
 * suggest, archive) lives in the shared body so the standalone
 * `/projects/:id` page (`ProjectDetailPage`) renders exactly the
 * same UI without duplication. Everything dialog-specific — Radix
 * `Dialog.Root` / `Portal` / `Overlay` / `Content`, right-side
 * slide-in positioning, close-on-escape / close-on-outside-click —
 * stays here. See `ProjectDetailBody.tsx` for the actual content.
 *
 * The modal title text is rendered inside the body as a `<Link>` to
 * `/projects/:id` (via `showPageLink`), so cmd/middle-click opens
 * the standalone page in a new tab and left-click closes the modal
 * before client-side navigating (via `onNavigatedAway`).
 */
export function ProjectDetailPanel({
  id,
  onClose,
  onOpenProject,
  siblingIds,
}: {
  id: string;
  onClose: () => void;
  /**
   * Optional handler the parent view passes so breadcrumb / children
   * clicks can swap the currently-selected project without closing the
   * panel. Views that don't supply it fall back to a plain close.
   */
  onOpenProject?: (nextId: string) => void;
  /**
   * Optional ordered list of the surrounding items the user is
   * browsing (Board lane+position, Roadmap chart order, KPI section
   * order, etc.). When present the header renders prev/next chevrons
   * and the arrow keys wire up so the user can walk the list without
   * closing the panel back to the parent view. The current id must
   * appear in the list; if it doesn't (stale filter change, deletion,
   * etc.) nav collapses gracefully to disabled controls.
   */
  siblingIds?: string[];
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col bg-white shadow-xl outline-none">
          <ProjectDetailBody
            projectId={id}
            onClose={onClose}
            onNavigatedAway={onClose}
            variant="modal"
            showPageLink
            onOpenProject={onOpenProject}
            siblingIds={siblingIds}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
