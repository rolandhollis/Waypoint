import cron from "node-cron";
import { config } from "../config.js";
import {
  drainJiraSyncOutbox,
  jiraSyncActive,
  reconcileJiraProjects,
} from "../lib/jiraSync.js";

export function startJiraSyncCron() {
  if (!jiraSyncActive()) {
    console.log("[cron] jira sync idle (JIRA_SYNC_ENABLED off or credentials missing)");
    return;
  }

  const tz = config.reportingTimezone;

  // Drain outbound outbox every minute.
  cron.schedule(
    "* * * * *",
    () =>
      drainJiraSyncOutbox(40).catch((err) =>
        console.error("[cron] jira outbox drain failed:", err),
      ),
    { timezone: tz },
  );

  // Nightly reconcile at 2:15am reporting TZ.
  cron.schedule(
    "15 2 * * *",
    () =>
      reconcileJiraProjects(200)
        .then((n) => console.log(`[cron] jira reconcile applied ${n} inbound status updates`))
        .catch((err) => console.error("[cron] jira reconcile failed:", err)),
    { timezone: tz },
  );

  console.log(`[cron] jira sync scheduled (outbox * * * * *; reconcile 02:15 ${tz})`);
}
