import { useHealth, useMe, useMockRoster } from "../lib/queries";
import { useMockUserStore } from "../lib/mockUser";
import { useQueryClient } from "@tanstack/react-query";

export function UserSwitcher() {
  const health = useHealth();
  const me = useMe();
  const roster = useMockRoster();
  const setMockUserId = useMockUserStore((s) => s.setMockUserId);
  const qc = useQueryClient();
  const isMockMode = health.data?.auth === "mock";

  // In prod modes there's no impersonation — just show who's signed in.
  if (!isMockMode) {
    if (!me.data) return null;
    return (
      <div className="flex items-center gap-2 text-xs text-wp-slate">
        <span>Signed in as</span>
        <span className="font-medium text-wp-ink">{me.data.name}</span>
        <span className="chip">{me.data.role}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right text-xs text-wp-slate sm:block">
        Signed in as
        <div className="font-medium text-wp-ink">{me.data?.name}</div>
      </div>
      <select
        className="input w-48"
        aria-label="Switch mock user"
        value={me.data?.id ?? ""}
        onChange={(e) => {
          setMockUserId(e.target.value || null);
          qc.invalidateQueries();
        }}
      >
        {roster.data?.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name} ({u.role})
          </option>
        ))}
      </select>
    </div>
  );
}
