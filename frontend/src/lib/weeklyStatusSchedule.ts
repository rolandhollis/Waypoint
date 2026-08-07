/** ISO weekday labels — 1 = Monday … 7 = Sunday. */
export const WEEKDAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

export const REPORTING_TIMEZONE_OPTIONS = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "UTC",
] as const;

export function formatWeekday(day: number): string {
  return WEEKDAY_OPTIONS.find((d) => d.value === day)?.label ?? `Day ${day}`;
}

export function formatScheduleSlot(day: number, time: string, timezone: string): string {
  return `${formatWeekday(day)} at ${time} (${timezone})`;
}
