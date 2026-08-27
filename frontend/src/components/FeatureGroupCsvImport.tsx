import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { Loader2, Upload, X } from "lucide-react";
import { useAppDialog } from "./AppDialogProvider";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { api } from "../lib/api";
import type { FeatureGroupSummary } from "../lib/types";

type ImportResponse = {
  imported_count: number;
  coerced_tier_count: number;
  group: FeatureGroupSummary;
};

export function FeatureGroupCsvImport({
  groupId,
  disabled,
}: {
  groupId: string;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const { alert } = useAppDialog();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const importMutation = useMutation({
    mutationFn: (csv: string) =>
      api<ImportResponse>(`/feature-groups/${groupId}/features/import-csv`, {
        method: "POST",
        body: JSON.stringify({ csv }),
      }),
    onSuccess: async (result) => {
      qc.setQueryData(["featureGroups", groupId], result.group);
      qc.invalidateQueries({ queryKey: ["featureGroups"] });
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFilename(null);
      setOpen(false);
      importMutation.reset();

      const coercedNote =
        result.coerced_tier_count > 0
          ? ` ${result.coerced_tier_count} row${
              result.coerced_tier_count === 1 ? "" : "s"
            } had an invalid priority tier and were placed in P3.`
          : "";
      await alert({
        title: "Import complete",
        description: `Added ${result.imported_count} feature${
          result.imported_count === 1 ? "" : "s"
        } in CSV order.${coercedNote}`,
      });
    },
  });

  function closeModal() {
    if (importMutation.isPending) return;
    setOpen(false);
    setFilename(null);
    setReadError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    importMutation.reset();
  }

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function handleFile(file: File | undefined) {
    if (!file || importMutation.isPending) return;
    setFilename(file.name);
    setReadError(null);
    try {
      const text = await file.text();
      importMutation.mutate(text);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label="Import CSV"
      >
        <Upload size={16} />
      </button>

      {open ? (
        <Dialog.Root open onOpenChange={(next) => { if (!next) closeModal(); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-wp-stone px-5 py-3">
                <Dialog.Title className="text-base font-semibold">Import features from CSV</Dialog.Title>
                <button aria-label="Close" className="btn-ghost !p-1" onClick={closeModal}>
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-4 overflow-y-auto px-5 py-4 text-sm text-wp-slate">
                <p>
                  Upload a CSV with one feature per row. Features are appended to this group in file
                  order — that sequence becomes overall rank.
                </p>

                <div className="rounded-md border border-wp-stone bg-wp-bg/60 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-wp-slate">
                    Columns
                  </p>
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-wp-slate">
                        <th className="pb-1 pr-3 font-medium">Column</th>
                        <th className="pb-1 font-medium">Required</th>
                      </tr>
                    </thead>
                    <tbody className="text-wp-ink">
                      <tr>
                        <td className="py-1 pr-3 font-mono text-xs">priority tier</td>
                        <td className="py-1">Optional — P0, P1, P2, or P3 (invalid → P3)</td>
                      </tr>
                      <tr>
                        <td className="py-1 pr-3 font-mono text-xs">name</td>
                        <td className="py-1">Required</td>
                      </tr>
                      <tr>
                        <td className="py-1 pr-3 font-mono text-xs">description</td>
                        <td className="py-1">Optional</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="rounded-md border border-wp-stone bg-wp-stone/20 p-3 font-mono text-xs text-wp-ink">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-wp-slate">
                    Example
                  </p>
                  priority tier,name,description<br />
                  P0,Login with SSO,OAuth for enterprise<br />
                  P1,Dark mode,Optional theme toggle
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => void handleFile(e.target.files?.[0])}
                />

                {filename && importMutation.isPending ? (
                  <p className="text-xs text-wp-slate">Importing {filename}…</p>
                ) : filename ? (
                  <p className="text-xs text-wp-slate">Selected: {filename}</p>
                ) : null}
              </div>

              <div className="border-t border-wp-stone bg-white px-5 py-3">
                {readError ? (
                  <p className="mb-2 text-sm text-wp-red">{readError}</p>
                ) : null}
                <MutationErrorBanner mutation={importMutation} className="mb-2" />
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn-secondary" onClick={closeModal}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={importMutation.isPending}
                    onClick={pickFile}
                  >
                    {importMutation.isPending ? (
                      <>
                        <Loader2 size={14} className="mr-1 inline animate-spin" />
                        Importing…
                      </>
                    ) : (
                      <>
                        <Upload size={14} className="mr-1 inline" />
                        Choose CSV file
                      </>
                    )}
                  </button>
                </div>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
