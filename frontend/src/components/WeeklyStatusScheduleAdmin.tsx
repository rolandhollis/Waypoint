import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import {
  useCurrentGroup,
  useGroupConstants,
  useMe,
} from "../lib/queries";
import type { AppConstants, WeeklyStatusSchedule } from "../lib/types";
import {
  formatScheduleSlot,
  REPORTING_TIMEZONE_OPTIONS,
  WEEKDAY_OPTIONS,
} from "../lib/weeklyStatusSchedule";
import { useAppDialog } from "./AppDialogProvider";
import { MutationErrorBanner } from "./MutationErrorBanner";

type ScheduleDraft = WeeklyStatusSchedule;

function scheduleFromEffective(
  effective: WeeklyStatusSchedule | undefined,
): ScheduleDraft {
  return {
    timezone: effective?.timezone ?? "America/Chicago",
    due_day: effective?.due_day ?? 4,
    due_time: effective?.due_time ?? "23:59",
    reminder_day: effective?.reminder_day ?? 4,
    reminder_time: effective?.reminder_time ?? "10:00",
    digest_day: effective?.digest_day ?? 5,
    digest_time: effective?.digest_time ?? "17:00",
  };
}

/**
 * Admin panel for per-workspace weekly status email timing — due date,
 * owner reminder, and Friday digest. Stored in `groups.constants` and
 * read by the server cron tick.
 */
export function WeeklyStatusScheduleAdmin() {
  const me = useMe();
  const currentGroup = useCurrentGroup();
  const groupId = me.data?.current_group_id ?? null;

  if (!groupId) {
    return (
      <section className="card-surface p-4">
        <h2 className="text-base font-semibold text-wp-ink">Weekly status schedule</h2>
        <p className="mt-2 text-xs text-wp-slate">
          No active group selected — pick one from the workspace switcher to edit its schedule.
        </p>
      </section>
    );
  }

  return <WeeklyStatusScheduleForm groupId={groupId} groupName={currentGroup?.name ?? "this workspace"} />;
}

function WeeklyStatusScheduleForm({
  groupId,
  groupName,
}: {
  groupId: string;
  groupName: string;
}) {
  const qc = useQueryClient();
  const { confirm } = useAppDialog();
  const constantsQ = useGroupConstants(groupId);
  const effective = constantsQ.data?.weekly_status_schedule_effective;
  const persisted = scheduleFromEffective(effective);

  const [draft, setDraft] = useState<ScheduleDraft>(persisted);
  useEffect(() => {
    setDraft(scheduleFromEffective(effective));
  }, [effective]);

  const patch = useMutation({
    mutationFn: (body: Pick<AppConstants, "weekly_status_schedule">) =>
      api<AppConstants>(`/groups/${groupId}/constants`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["groupConstants", groupId] });
    },
  });

  const isDirty =
    draft.timezone !== persisted.timezone ||
    draft.due_day !== persisted.due_day ||
    draft.due_time !== persisted.due_time ||
    draft.reminder_day !== persisted.reminder_day ||
    draft.reminder_time !== persisted.reminder_time ||
    draft.digest_day !== persisted.digest_day ||
    draft.digest_time !== persisted.digest_time;

  const hasOverrides = constantsQ.data?.weekly_status_schedule != null;

  return (
    <section className="card-surface p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-wp-stone/40 text-wp-slate">
          <CalendarClock size={16} />
        </span>
        <div>
          <h2 className="text-base font-semibold text-wp-ink">Weekly status schedule</h2>
          <p className="mt-1 text-xs text-wp-slate">
            Controls when status updates are due and when reminder and digest emails fire for{" "}
            <span className="font-medium text-wp-ink">{groupName}</span>. Times use the selected
            timezone. Changes apply on the next scheduled minute — no redeploy required.
          </p>
        </div>
      </div>

      <MutationErrorBanner mutation={patch} className="mt-4" />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Timezone">
          <select
            className="input"
            disabled={constantsQ.isLoading || patch.isPending}
            value={draft.timezone}
            onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
          >
            {REPORTING_TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
            {!REPORTING_TIMEZONE_OPTIONS.includes(
              draft.timezone as typeof REPORTING_TIMEZONE_OPTIONS[number],
            ) ? (
              <option value={draft.timezone}>{draft.timezone}</option>
            ) : null}
          </select>
        </Field>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ScheduleRow
          title="Status due"
          description="Owners must submit before this day and time each week."
          day={draft.due_day}
          time={draft.due_time}
          disabled={constantsQ.isLoading || patch.isPending}
          onDayChange={(v) => setDraft((d) => ({ ...d, due_day: v }))}
          onTimeChange={(v) => setDraft((d) => ({ ...d, due_time: v }))}
        />
        <ScheduleRow
          title="Owner reminder email"
          description="One email per owner listing pending updates they owe."
          day={draft.reminder_day}
          time={draft.reminder_time}
          disabled={constantsQ.isLoading || patch.isPending}
          onDayChange={(v) => setDraft((d) => ({ ...d, reminder_day: v }))}
          onTimeChange={(v) => setDraft((d) => ({ ...d, reminder_time: v }))}
        />
        <ScheduleRow
          title="Digest email"
          description="Rollup of submitted updates to digest recipients."
          day={draft.digest_day}
          time={draft.digest_time}
          disabled={constantsQ.isLoading || patch.isPending}
          onDayChange={(v) => setDraft((d) => ({ ...d, digest_day: v }))}
          onTimeChange={(v) => setDraft((d) => ({ ...d, digest_time: v }))}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!isDirty || patch.isPending}
          onClick={() =>
            patch.mutate({
              weekly_status_schedule: {
                timezone: draft.timezone,
                due_day: draft.due_day,
                due_time: draft.due_time,
                reminder_day: draft.reminder_day,
                reminder_time: draft.reminder_time,
                digest_day: draft.digest_day,
                digest_time: draft.digest_time,
              },
            })
          }
        >
          {patch.isPending ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1.5"
          disabled={!hasOverrides || patch.isPending}
          onClick={async () => {
            if (
              !(await confirm({
                title: "Reset weekly status schedule?",
                description:
                  "Reset weekly status schedule to the built-in defaults for this workspace?",
              }))
            ) return;
            patch.mutate({ weekly_status_schedule: null });
          }}
        >
          <RotateCcw size={13} />
          Reset to defaults
        </button>
      </div>

      <p className="mt-3 text-[11px] text-wp-slate">
        Active schedule: reminder{" "}
        {formatScheduleSlot(persisted.reminder_day, persisted.reminder_time, persisted.timezone)};
        digest{" "}
        {formatScheduleSlot(persisted.digest_day, persisted.digest_time, persisted.timezone)};
        due{" "}
        {formatScheduleSlot(persisted.due_day, persisted.due_time, persisted.timezone)}.
      </p>
    </section>
  );
}

function ScheduleRow(props: {
  title: string;
  description: string;
  day: number;
  time: string;
  disabled?: boolean;
  onDayChange: (day: number) => void;
  onTimeChange: (time: string) => void;
}) {
  return (
    <div className="rounded-md border border-wp-stone bg-white p-3">
      <div className="text-sm font-medium text-wp-ink">{props.title}</div>
      <p className="mt-0.5 text-[11px] text-wp-slate">{props.description}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <select
          className="input min-w-[9rem]"
          disabled={props.disabled}
          value={props.day}
          onChange={(e) => props.onDayChange(Number(e.target.value))}
        >
          {WEEKDAY_OPTIONS.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
        <input
          type="time"
          className="input w-[8.5rem]"
          disabled={props.disabled}
          value={props.time}
          onChange={(e) => props.onTimeChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-wp-slate">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
