import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { useMe, useProductAreas, useSwimLanes, useUsers } from "../lib/queries";
import type { Project } from "../lib/types";
import { MutationErrorBanner } from "./MutationErrorBanner";

export function NewProjectDialog({ defaultLaneId, onClose }: { defaultLaneId: string | null; onClose: () => void }) {
  const me = useMe();
  const lanes = useSwimLanes();
  const users = useUsers();
  const areas = useProductAreas();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [laneId, setLaneId] = useState<string | null>(defaultLaneId);
  const [ownerId, setOwnerId] = useState<string | null>(me.data?.id ?? null);
  const [areaId, setAreaId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({
        title,
        description: description.trim() || undefined,
        swim_lane_id: laneId,
        owner_id: ownerId,
        product_area_id: areaId,
      }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold">New project</Dialog.Title>
            <button aria-label="Close" className="btn-ghost !p-1" onClick={onClose}><X size={18} /></button>
          </div>
          <div className="space-y-3">
            <label className="block text-xs font-medium text-wp-slate">Title
              <input className="input mt-1" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="block text-xs font-medium text-wp-slate">
              Description <span className="text-wp-slate/70">(optional)</span>
              <textarea
                className="input mt-1 min-h-[5rem]"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project? Add context, links, or acceptance notes."
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-wp-slate">Swim lane
                <select className="input mt-1" value={laneId ?? ""} onChange={(e) => setLaneId(e.target.value || null)}>
                  <option value="">— Unassigned —</option>
                  {lanes.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium text-wp-slate">Owner
                <select className="input mt-1" value={ownerId ?? ""} onChange={(e) => setOwnerId(e.target.value || null)}>
                  <option value="">— Unassigned —</option>
                  {users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium text-wp-slate">Product Area
                <select className="input mt-1" value={areaId ?? ""} onChange={(e) => setAreaId(e.target.value || null)}>
                  <option value="">— Unassigned —</option>
                  {areas.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </div>
          </div>
          <MutationErrorBanner mutation={create} className="mt-4" />
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!title.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
