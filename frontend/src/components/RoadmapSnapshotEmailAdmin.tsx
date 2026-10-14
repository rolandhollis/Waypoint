import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Camera, Mail, Send } from "lucide-react";

import { api } from "../lib/api";
import { useMe } from "../lib/queries";
import { MutationErrorBanner } from "./MutationErrorBanner";
import { useAppDialog } from "./AppDialogProvider";
import {
  roadmapSnapshotSubject,
  useRoadmapSnapshotSend,
  type RoadmapSnapshotRunResult,
} from "./RoadmapSnapshotSendProvider";

type DigestRecipient = {
  id: string;
  email: string;
  user_id: string | null;
  user_name: string | null;
};

type SnapshotRunMode = "dry_run" | "test_to_self" | "send_all";

function bannerClass(errors: number, sent: number, dryRun: boolean): string {
  if (errors > 0 && sent === 0) return "border-red-200 bg-red-50 text-red-900";
  if (errors > 0) return "border-amber-200 bg-amber-50 text-amber-900";
  if (dryRun) return "border-wp-stone bg-wp-stone/20 text-wp-ink";
  if (sent === 0) return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-emerald-200 bg-emerald-50 text-emerald-900";
}

function runTitle(last: RoadmapSnapshotRunResult): string {
  if (last.errors > 0 && last.sent === 0) {
    return "Roadmap snapshot send failed — check server logs and RESEND_API_KEY.";
  }
  if (last.errors > 0) {
    return "Snapshot sent with errors — some recipients may not have received email.";
  }
  if (last.dryRun) {
    return "Preview complete — no emails sent.";
  }
  if (last.testToSelf) {
    if (last.sent === 0) return "Test email was not sent.";
    return `Test roadmap snapshot sent to you only (${last.teamCount} team image${last.teamCount === 1 ? "" : "s"}).`;
  }
  if (last.sent === 0 && last.recipients === 0) {
    return "No recipients on the distribution list — nothing to send.";
  }
  if (last.sent === 0) return "No roadmap snapshot emails sent.";
  return `Roadmap snapshot sent to ${last.sent} recipient${last.sent === 1 ? "" : "s"} (${last.teamCount} team image${last.teamCount === 1 ? "" : "s"}).`;
}

/**
 * Admin trigger: capture a Compact 3-month PNG per team and email
 * the digest roster. Also auto-runs after a successful digest Send now
 * (see DigestAdmin + RoadmapSnapshotSendProvider).
 */
export function RoadmapSnapshotEmailAdmin() {
  const { confirm, alert } = useAppDialog();
  const me = useMe();
  const { dataReady, teamCount, sendRoadmapSnapshot } = useRoadmapSnapshotSend();

  const recipients = useQuery({
    queryKey: ["digestRecipients"],
    queryFn: () => api<DigestRecipient[]>("/notifications/digest-recipients"),
  });

  const [subject, setSubject] = useState(roadmapSnapshotSubject);
  const [intro, setIntro] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<SnapshotRunMode | null>(null);
  const [last, setLast] = useState<RoadmapSnapshotRunResult | null>(null);

  const previewMutation = useMutation({
    mutationFn: (args: { subject: string; intro?: string }) =>
      api<RoadmapSnapshotRunResult>("/notifications/roadmap-snapshot/run", {
        method: "POST",
        body: JSON.stringify({
          dry_run: true,
          test_to_self: false,
          subject: args.subject,
          intro: args.intro,
          teams: [],
        }),
      }),
    onSuccess: (data) => setLast(data),
  });

  const subjectTrimmed = subject.trim();
  const ready = subjectTrimmed.length > 0;
  const recipientCount = recipients.data?.length ?? 0;
  const myEmail = me.data?.email?.trim() ?? "";
  const busy = previewMutation.isPending || progress != null;

  async function handlePreview() {
    if (!ready || busy) return;
    setRunMode("dry_run");
    setProgress("Previewing…");
    try {
      await previewMutation.mutateAsync({
        subject: subjectTrimmed,
        intro: intro.trim() || undefined,
      });
    } finally {
      setProgress(null);
      setRunMode(null);
    }
  }

  async function captureAndSend(mode: "test_to_self" | "send_all") {
    if (!ready || busy || !dataReady) return;
    if (mode === "test_to_self" && !myEmail) {
      await alert({
        title: "No email on your account",
        description: "Your user record has no email address, so a test send can’t be delivered.",
      });
      return;
    }
    if (mode === "send_all" && recipientCount === 0) return;

    if (
      !(await confirm(
        mode === "test_to_self"
          ? {
              title: "Send test to yourself?",
              description: `Capture charts for ${teamCount} team${teamCount === 1 ? "" : "s"} and email only ${myEmail}. The distribution list will not be emailed.`,
              confirmLabel: "Send test to me",
            }
          : {
              title: "Send roadmap snapshot now?",
              description: `Capture a 3-month Compact chart for each of ${teamCount} team${teamCount === 1 ? "" : "s"} and email ${recipientCount} distribution-list recipient${recipientCount === 1 ? "" : "s"}.`,
              confirmLabel: "Capture & send",
            },
      ))
    ) {
      return;
    }

    setRunMode(mode);
    try {
      // Refresh subject to today's date at send time unless the admin edited it
      // away from the previous auto-default pattern — always use the field value.
      const result = await sendRoadmapSnapshot({
        testToSelf: mode === "test_to_self",
        subject: subjectTrimmed,
        intro: intro.trim() || undefined,
        onProgress: setProgress,
      });
      setLast(result);
    } catch (err) {
      await alert({
        title: "Roadmap snapshot failed",
        description: err instanceof Error ? err.message : "Check the browser console for details.",
      });
    } finally {
      setProgress(null);
      setRunMode(null);
    }
  }

  return (
    <section className="card-surface p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-800">
          <Camera size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-wp-ink">
            Roadmap snapshot email
          </h2>
          <p className="mt-1 text-xs text-wp-slate">
            Capture a Compact 3-month roadmap PNG for each team (admin team order)
            and send them to the{" "}
            <span className="font-medium text-wp-ink">Email distribution list</span>{" "}
            above. Each block lists items in development, then a chart that deep-links
            to that team&apos;s filtered roadmap. Also queued automatically after a successful
            weekly status digest (manual or scheduled) — keep this Notifications tab open so
            charts can be captured in the browser.
          </p>
        </div>
      </div>

      <MutationErrorBanner mutation={previewMutation} className="mt-4" />

      <div className="mt-4 space-y-3">
        <label className="block text-xs font-medium text-wp-slate">
          Subject
          <input
            type="text"
            className="input mt-1 w-full text-sm"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            disabled={busy}
          />
        </label>
        <label className="block text-xs font-medium text-wp-slate">
          Intro (optional)
          <textarea
            className="input mt-1 w-full text-sm"
            rows={3}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
            placeholder="Short note above the team roadmaps…"
            maxLength={2000}
            disabled={busy}
          />
        </label>
        <p className="text-[11px] text-wp-slate">
          {teamCount === 0
            ? "No teams in this group yet."
            : `Will include ${teamCount} team image${teamCount === 1 ? "" : "s"}`}
          {recipientCount === 0
            ? " · No recipients on the distribution list yet."
            : ` · ${recipientCount} recipient${recipientCount === 1 ? "" : "s"} on the distribution list.`}
        </p>
        {progress ? (
          <p className="text-xs font-medium text-wp-ink" role="status">
            {progress}
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={busy || !ready}
          onClick={() => void handlePreview()}
        >
          <Mail size={13} />
          {runMode === "dry_run" ? "Previewing…" : "Preview (dry run)"}
        </button>
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={busy || !ready || !dataReady || teamCount === 0 || !myEmail}
          onClick={() => void captureAndSend("test_to_self")}
          title={myEmail ? `Send only to ${myEmail}` : "Your account has no email"}
        >
          <Mail size={13} />
          {runMode === "test_to_self" ? "Sending test…" : "Send test to me"}
        </button>
        <button
          type="button"
          className="btn-primary inline-flex items-center gap-1.5"
          disabled={busy || !ready || recipientCount === 0 || !dataReady || teamCount === 0}
          onClick={() => void captureAndSend("send_all")}
        >
          <Send size={13} />
          {runMode === "send_all" ? "Working…" : "Capture & send to list"}
        </button>
      </div>

      {last ? (
        <div
          className={
            "mt-4 rounded-md border px-3 py-2 text-xs " +
            bannerClass(last.errors, last.sent, last.dryRun)
          }
          role="status"
        >
          <div className="font-medium">{runTitle(last)}</div>
          <div className="mt-0.5 text-[11px] opacity-80">
            day={last.dayOf} · recipients={last.recipients} · sent={last.sent}
            · errors={last.errors} · teams={last.teamCount}
            {last.dryRun ? " · dry run" : ""}
            {last.testToSelf ? " · test to self" : ""}
          </div>
        </div>
      ) : null}
    </section>
  );
}
