/**
 * Google Chat incoming webhook helper.
 * https://developers.google.com/workspace/chat/quickstart/webhooks
 */

export type GoogleChatSendResult = {
  ok: boolean;
  status: number;
  body: string;
  dryRun: boolean;
};

export async function postGoogleChatWebhook(opts: {
  webhookUrl: string;
  text: string;
  dryRun?: boolean;
}): Promise<GoogleChatSendResult> {
  const url = opts.webhookUrl.trim();
  if (!url) {
    throw new Error("Google Chat webhook URL is empty");
  }
  if (opts.dryRun) {
    console.warn(`[google-chat] dry-run — would post to webhook (${opts.text.length} chars)`);
    return { ok: true, status: 0, body: "dry-run", dryRun: true };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text: opts.text }),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Google Chat webhook failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return { ok: true, status: res.status, body, dryRun: false };
}
