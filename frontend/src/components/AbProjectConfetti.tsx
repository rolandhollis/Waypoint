import { useRef, useState } from "react";
import confetti from "canvas-confetti";
import { useQueryClient } from "@tanstack/react-query";
import { PartyPopper } from "lucide-react";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { isAbSdkConfigured, useAbSdk } from "../lib/abSdk";
import { cn } from "../lib/cn";

/**
 * ZiffSplit slot: Celebrate button on project detail (page + modal).
 *
 * Container: `project_confetti`
 * Delivery: embedded
 *
 * - Container feature flag **off** → button hidden
 * - Flag on / no SDK → button shown; click fires full-viewport confetti
 * - Click also writes a project audit event (with ZiffSplit context when enabled)
 */
export const PROJECT_CONFETTI_CONTAINER = "project_confetti";

const BRAND_COLORS = ["#E01F2D", "#F03A45", "#FFC857", "#5B8DEF", "#34D399", "#F472B6", "#FFFFFF"];

function fireFullPageConfetti(): () => void {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = [
    "position:fixed",
    "inset:0",
    "width:100%",
    "height:100%",
    "pointer-events:none",
    "z-index:2147483646",
  ].join(";");
  document.body.appendChild(canvas);

  const fire = confetti.create(canvas, { resize: true, useWorker: true });
  const end = Date.now() + 2800;

  const frame = () => {
    fire({
      particleCount: 4,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.65 },
      colors: BRAND_COLORS,
      startVelocity: 45,
      gravity: 0.9,
      scalar: 1.1,
      ticks: 220,
    });
    fire({
      particleCount: 4,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.65 },
      colors: BRAND_COLORS,
      startVelocity: 45,
      gravity: 0.9,
      scalar: 1.1,
      ticks: 220,
    });
    if (Date.now() < end) {
      requestAnimationFrame(frame);
    }
  };
  frame();

  // Center burst for punch
  fire({
    particleCount: 120,
    spread: 100,
    origin: { y: 0.45 },
    colors: BRAND_COLORS,
    startVelocity: 55,
    scalar: 1.2,
  });
  setTimeout(() => {
    fire({
      particleCount: 80,
      spread: 120,
      origin: { y: 0.35 },
      colors: BRAND_COLORS,
      startVelocity: 35,
      scalar: 0.9,
    });
  }, 400);

  const cleanup = () => {
    fire.reset();
    canvas.remove();
  };
  window.setTimeout(cleanup, 4500);
  return cleanup;
}

/**
 * Header Celebrate control. Mount in ProjectDetailBody (shared by
 * page + modal). Records a container assignment exposure when an
 * experiment is attached; respects the site container feature flag.
 */
export function AbProjectConfettiButton({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const ab = useAbSdk();
  void ab.previewRevision;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  if (isAbSdkConfigured()) {
    if (!ab.ready) return null;
    if (ab.error) return null;
    if (!ab.isContainerEnabled(PROJECT_CONFETTI_CONTAINER)) return null;
    // Fire exposure when an experiment is live on this container.
    ab.getAssignmentByContainer(PROJECT_CONFETTI_CONTAINER);
  }

  async function celebrate() {
    if (busy) return;
    setBusy(true);
    cleanupRef.current?.();
    cleanupRef.current = fireFullPageConfetti();
    // Measurement path: sticky subject id + named event for ZiffSplit KPI joins.
    track("celebrate", { projectId, source: "project_confetti" });
    try {
      await api(`/projects/${projectId}/celebrate`, { method: "POST" });
      void qc.invalidateQueries({ queryKey: ["projectHistory", projectId] });
      void qc.invalidateQueries({ queryKey: ["recentAuditEvents"] });
    } catch (err) {
      console.warn("[celebrate] audit failed", err);
    } finally {
      window.setTimeout(() => setBusy(false), 3200);
    }
  }

  return (
    <button
      type="button"
      className={cn("btn-ghost inline-flex items-center gap-1.5 !px-2 !py-1 text-xs", className)}
      onClick={() => void celebrate()}
      disabled={busy}
      title="Celebrate with confetti"
      aria-label="Celebrate with confetti"
    >
      <PartyPopper size={16} className="text-wp-red" />
      <span className="hidden sm:inline">Celebrate</span>
    </button>
  );
}
