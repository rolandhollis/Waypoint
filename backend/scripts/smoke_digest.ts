// One-off smoke driver — invoke via `tsx scripts/smoke_digest.ts`.
// Exercises the dry-run digest pass and prints a digest-unsubscribe
// token for the given recipient row id. Never sends real email.
import { runStatusReportDigest, DIGEST_UNSUB_KIND } from "../src/notifications/statusDigest.js";
import { makeUnsubscribeToken, verifyUnsubscribeToken } from "../src/notifications/unsubscribe.js";

const [, , subcommand, ...rest] = process.argv;

async function main() {
  if (subcommand === "dry-run") {
    const groupId = rest[0];
    const r = await runStatusReportDigest({
      dryRun: true,
      scopeGroupId: groupId || undefined,
    });
    console.log("dry-run:", JSON.stringify(r));
    return;
  }
  if (subcommand === "token") {
    const recipientId = rest[0];
    if (!recipientId) throw new Error("usage: smoke_digest token <digest_recipient_id>");
    const t = makeUnsubscribeToken(recipientId, DIGEST_UNSUB_KIND);
    const back = verifyUnsubscribeToken(t);
    console.log("token:", t);
    console.log("verified:", JSON.stringify(back));
    console.log("tampered:", verifyUnsubscribeToken(t + "xx"));
    return;
  }
  console.error("usage: smoke_digest <dry-run|token> [group_id|recipient_id]");
  process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
