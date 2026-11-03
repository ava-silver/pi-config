import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Publishes a message to an ntfy topic URL, ignoring failures such as the server not running. */
export function sendNotification(topicUrl: string, title: string, message: string): Promise<void> {
  return fetch(topicUrl, {
    method: "POST",
    headers: { Title: title },
    body: message,
    signal: AbortSignal.timeout(2000),
  }).then(
    () => undefined,
    () => undefined,
  );
}

export default function phoneNotifyExtension(pi: ExtensionAPI): void {
  const topicUrl = process.env.PI_NTFY_URL;
  if (!topicUrl) return;

  pi.on("agent_settled", async (_event, ctx) => {
    await sendNotification(topicUrl, "pi", `${basename(ctx.cwd)}: finished`);
  });
}
