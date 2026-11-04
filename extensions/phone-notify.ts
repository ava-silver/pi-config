import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Notification {
  title: string;
  message: string;
  priority: "default" | "high";
}

const MAX_MESSAGE_LENGTH = 120;

const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? "";

const truncate = (text: string): string =>
  text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;

/** Describes how a run ended, from the last assistant message of the run. */
export function runNotification(cwd: string, last: AssistantMessage | undefined): Notification {
  const project = basename(cwd);
  if (last?.stopReason === "error") {
    return {
      title: `${project}: error`,
      message: truncate(firstLine(last.errorMessage ?? "") || "The run failed"),
      priority: "high",
    };
  }
  const text = last?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? "";
  return { title: `${project}: done`, message: truncate(firstLine(text) || "Finished"), priority: "default" };
}

/** Describes a prompt that blocks on the user. */
export function promptNotification(cwd: string, title: string | undefined): Notification {
  return { title: `${basename(cwd)}: needs you`, message: title ?? "Waiting for your input", priority: "high" };
}

/** Posts an Android notification through Termux:API, ignoring failures such as the app not being installed. */
export function sendNotification({ title, message, priority }: Notification): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("termux-notification", ["--title", title, "--content", message, "--priority", priority], {
      stdio: "ignore",
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

export default function phoneNotifyExtension(pi: ExtensionAPI): void {
  let last: AssistantMessage | undefined;

  pi.on("agent_end", (event) => {
    last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
  });

  // Escape means you are already at the keyboard, so only notify for runs that ran to the end.
  pi.on("agent_settled", async (event, ctx) => {
    if (!event.aborted) await sendNotification(runNotification(ctx.cwd, last));
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    await sendNotification(promptNotification(ctx.cwd, event.title));
  });
}
