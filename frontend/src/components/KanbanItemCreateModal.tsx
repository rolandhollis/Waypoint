import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { X } from "lucide-react";
import { MutationErrorBanner } from "./MutationErrorBanner";

type AnyMutation = Pick<UseMutationResult, "isError" | "error" | "reset" | "isPending">;

export function KanbanItemCreateModal({
  title,
  onClose,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  teamId,
  onTeamIdChange,
  teamOptions,
  extraFields,
  onSubmit,
  canSubmit,
  mutation,
  nameFieldId,
  descriptionFieldId,
}: {
  title: string;
  onClose: () => void;
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  teamId: string;
  onTeamIdChange: (value: string) => void;
  teamOptions: { id: string; name: string }[];
  extraFields?: ReactNode;
  onSubmit: () => void;
  canSubmit: boolean;
  mutation: AnyMutation;
  nameFieldId: string;
  descriptionFieldId: string;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-wp-stone px-5 py-3">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <button aria-label="Close" className="btn-ghost !p-1" onClick={onClose}>
              <X size={18} />
            </button>
          </div>

          <form
            className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              onSubmit();
            }}
          >
            <label className="block text-xs font-medium text-wp-slate" htmlFor={nameFieldId}>
              Name
              <input
                id={nameFieldId}
                className="input mt-1 w-full"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                maxLength={256}
                required
                autoFocus
              />
            </label>
            <label className="block text-xs font-medium text-wp-slate" htmlFor={descriptionFieldId}>
              Description
              <textarea
                id={descriptionFieldId}
                className="input mt-1 w-full min-h-[80px]"
                value={description}
                onChange={(e) => onDescriptionChange(e.target.value)}
                rows={3}
              />
            </label>
            <div className="flex flex-wrap gap-4">
              <div className="min-w-[200px]">
                <label className="text-xs font-medium text-wp-slate" htmlFor={`${nameFieldId}-team`}>
                  Product area
                </label>
                <select
                  id={`${nameFieldId}-team`}
                  className="input mt-1 w-full"
                  value={teamId}
                  onChange={(e) => onTeamIdChange(e.target.value)}
                >
                  <option value="">— None —</option>
                  {teamOptions.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              {extraFields}
            </div>
          </form>

          <div className="border-t border-wp-stone bg-white px-5 py-3">
            <MutationErrorBanner mutation={mutation} className="mb-2" />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!canSubmit || mutation.isPending}
                onClick={onSubmit}
              >
                {mutation.isPending ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
