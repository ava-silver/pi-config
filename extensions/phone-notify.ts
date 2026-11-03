import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Notification {
  title: string;
  message: string;
  priority: "default" | "high";
}

const MAX_MESSAGE_LENGTH = 120;

const firstLine = (text: string): string => text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

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

/** Publishes to an ntfy topic URL, ignoring failures such as the server not running. */
export function sendNotification(topicUrl: string, { title, message, priority }: Notification): Promise<void> {
  const url = new URL(topicUrl);
  url.searchParams.set("title", title);
  url.searchParams.set("priority", priority);
  return fetch(url, { method: "POST", body: message, signal: AbortSignal.timeout(2000) }).then(
    () => undefined,
    () => undefined,
  );
}

const isLocal = (url: URL): boolean => url.hostname === "127.0.0.1" || url.hostname === "localhost";

const isHealthy = (url: URL): Promise<boolean> =>
  fetch(new URL("/v1/health", url), { signal: AbortSignal.timeout(500) }).then(
    (response) => response.ok,
    () => false,
  );

export interface LocalServer {
  /** Starts the server if nothing answers on its address. */
  ensureRunning: () => Promise<void>;
  /** Stops the server if this process started it. */
  stop: () => void;
}

/**
 * Manages a local `ntfy serve` for `topicUrl`. A server started by another Pi session is reused, and
 * restarted by whichever session notices it is gone, so its lifetime follows the sessions that use it.
 */
export function localServer(
  topicUrl: URL,
  start: (listen: string) => ChildProcess = (listen) =>
    spawn("ntfy", ["serve", "--listen-http", listen], { stdio: "ignore" }),
  waitForStartMs = 3000,
): LocalServer {
  let child: ChildProcess | undefined;
  let pending: Promise<void> | undefined;

  const waitUntilHealthy = async (): Promise<void> => {
    for (let waited = 0; waited < waitForStartMs && !(await isHealthy(topicUrl)); waited += 100) await sleep(100);
  };

  const launch = async (): Promise<void> => {
    if (await isHealthy(topicUrl)) return;
    const started = start(topicUrl.host);
    child = started;
    // A missing binary only disables notifications.
    started.once("error", () => {});
    started.once("exit", () => {
      if (child === started) child = undefined;
    });
    await waitUntilHealthy();
  };

  return {
    ensureRunning: () => (pending ??= launch().finally(() => (pending = undefined))),
    stop: () => {
      child?.kill();
      child = undefined;
    },
  };
}

export default function phoneNotifyExtension(pi: ExtensionAPI): void {
  const topicUrl = process.env.PI_NTFY_URL;
  if (!topicUrl) return;

  const url = new URL(topicUrl);
  const server = isLocal(url) ? localServer(url) : undefined;
  const publish = async (notification: Notification): Promise<void> => {
    await server?.ensureRunning();
    await sendNotification(topicUrl, notification);
  };

  let last: AssistantMessage | undefined;

  pi.on("session_start", async () => {
    await server?.ensureRunning();
  });

  pi.on("session_shutdown", () => server?.stop());

  pi.on("agent_end", (event) => {
    last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
  });

  // Escape means you are already at the keyboard, so only notify for runs that ran to the end.
  pi.on("agent_settled", async (event, ctx) => {
    if (!event.aborted) await publish(runNotification(ctx.cwd, last));
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    await publish(promptNotification(ctx.cwd, event.title));
  });
}
