import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { User, X } from "lucide-react";
import type { DesignItem } from "../lib/types";
import { MutationErrorBanner } from "./MutationErrorBanner";

type AnyMutation = Pick<UseMutationResult, "isError" | "error" | "reset" | "isPending">;

/**
 * Required when moving an unassigned item into In Design — design work
 * must have an owner before the layout change is persisted.
 */
export function DesignAssignPromptModal({
  item,
  userOptions,
  onConfirm,
  onDismiss,
  mutation,
}: {
  item: DesignItem;
  userOptions: { id: string; name: string }[];
  onConfirm: (assignedTo: string) => void;
  onDismiss: () => void;
  mutation: AnyMutation;
}) {
  const [assignedTo, setAssignedTo] = useState("");

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">Assign designer</Dialog.Title>
            <button aria-label="Close" className="btn-ghost !p-1" onClick={onDismiss} disabled={mutation.isPending}>
              <X size={18} />
            </button>
          </div>

          <p className="text-sm text-wp-slate">
            <span className="font-medium text-wp-ink">{item.name}</span> is moving to{" "}
            <span className="font-medium text-wp-ink">In Design</span>. Choose who will own this
            work.
          </p>

          <label className="mt-3 block text-xs font-medium text-wp-slate" htmlFor="design-assign-prompt">
            Assigned to <span className="text-wp-red">*</span>
            <select
              id="design-assign-prompt"
              className="input mt-1 w-full"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              disabled={mutation.isPending}
            >
              <option value="">— Select a user —</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </label>

          <MutationErrorBanner mutation={mutation} className="mt-3" />

          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-secondary" onClick={onDismiss} disabled={mutation.isPending}>
              Cancel
            </button>
            <button
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={!assignedTo || mutation.isPending}
              onClick={() => onConfirm(assignedTo)}
            >
              <User size={14} />
              {mutation.isPending ? "Saving…" : "Assign & move"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
