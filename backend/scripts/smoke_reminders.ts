// One-off smoke driver — invoke via `tsx scripts/smoke_reminders.ts`.
// Exercises the dry-run reminder pass, verifies unsubscribe token
// roundtrip, and prints a token for the given user id so a curl
// against /api/notifications/unsubscribe can be constructed
// externally. Never sends real email.
import { runStatusReportReminders } from "../src/notifications/statusReminders.js";
import { makeUnsubscribeToken, verifyUnsubscribeToken } from "../src/notifications/unsubscribe.js";

const [, , subcommand, ...rest] = process.argv;

async function main() {
  if (subcommand === "dry-run") {
    const r = await runStatusReportReminders({ dryRun: true });
    console.log("dry-run:", JSON.stringify(r));
    return;
  }
  if (subcommand === "token") {
    const uid = rest[0];
    const kind = rest[1] ?? "status_report_reminder";
    if (!uid) throw new Error("usage: smoke_reminders token <user_id> [kind]");
    const t = makeUnsubscribeToken(uid, kind);
    const back = verifyUnsubscribeToken(t);
    console.log("token:", t);
    console.log("verified:", JSON.stringify(back));
    console.log("tampered:", verifyUnsubscribeToken(t + "xx"));
    return;
  }
  console.error("usage: smoke_reminders <dry-run|token>");
  process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
