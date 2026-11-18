/**
 * Child side of the hc backend. A pi started by the parent with
 * `PI_SUBAGENT_CHANNEL` reports its activity to the channel's events file
 * and takes the parent's messages, answers, and interrupts from its inbox.
 * It gets ask_parent instead of the subagent tools.
 *
 * Parent messages reach the model wrapped in <parent_agent> tags. A run is
 * reported to the parent (RunStarted/RunSettled) only when a parent message
 * went into it, so turns the user starts in the child's terminal do not wake
 * the parent; their transcript still reaches it.
 */

import * as fs from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionCost } from "../../shared/session-cost.ts";
import { createParentQuestions } from "./ask-parent.ts";
import { assistantText, type Emit, finalOutput, messageRole, translateActivity } from "./backends/pi-events.ts";
import {
  appendLine,
  CHANNEL_ENV,
  channelPaths,
  isParentCommand,
  type ParentCommand,
  processIsRunning,
  tailJsonl,
} from "./channel.ts";
import type { SubagentMeta } from "./domain.ts";

const CHANNEL_KEY: unique symbol = Symbol.for("pi.background-subagents.channel");
const PARENT_OPEN = "<parent_agent>\n";
const PARENT_CLOSE = "\n</parent_agent>";
const PARENT_CHECK_MS = 2_000;
const CHILD_GUIDELINES = [
  "Messages wrapped in <parent_agent> tags come from the parent agent that delegated your task; your reply to them is delivered to it when your turn ends. Other user messages come directly from the user in your terminal, and your replies to those do not reach the parent.",
];

/**
 * The channel this process reports to, if it is an hc subagent. The variable
 * is removed from the environment so programs the child runs (such as
 * another pi) do not report to the parent; the value survives /reload.
 */
export function subagentChannel(): string | undefined {
  const globals = globalThis as typeof globalThis & { [CHANNEL_KEY]?: string };
  const fromEnv = process.env[CHANNEL_ENV];
  if (fromEnv) {
    globals[CHANNEL_KEY] = fromEnv;
    delete process.env[CHANNEL_ENV];
  }
  return globals[CHANNEL_KEY];
}

function currentMeta(ctx: ExtensionContext): SubagentMeta {
  const sessionFilePath = ctx.sessionManager.getSessionFile();
  return {
    ...(ctx.model ? { modelLabel: `${ctx.model.provider}/${ctx.model.id}` } : {}),
    ...(ctx.model?.contextWindow === undefined ? {} : { contextWindow: ctx.model.contextWindow }),
    ...(sessionFilePath === undefined ? {} : { sessionFilePath }),
  };
}

export function setupSubagentChild(pi: ExtensionAPI, dir: string) {
  const paths = channelPaths(dir);
  const emit: Emit = (event) => appendLine(paths.events, event);
  const questions = createParentQuestions(emit, CHILD_GUIDELINES);
  pi.registerTool(questions.tool);

  let ctx: ExtensionContext | undefined;
  let stopInbox: (() => void) | undefined;
  let parentWatch: ReturnType<typeof setInterval> | undefined;
  /** The current or next run took a parent message, so the parent hears of it. */
  let reported = false;
  let lastAssistant: AssistantMessage | undefined;
  let lastText = "";

  const emitUsage = (context: ExtensionContext) => {
    const usage = context.getContextUsage();
    emit({
      _tag: "UsageChanged",
      ...(typeof usage?.tokens === "number" ? { tokens: usage.tokens } : {}),
      ...(usage?.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
      cost: sessionCost(context.sessionManager.getEntries()),
    });
  };
  const handle = (command: ParentCommand) => {
    if (!ctx) return;
    switch (command.type) {
      case "send":
        // pi decides after async input hooks whether a run is active, so a turn the
        // user starts meanwhile would reject a message sent without deliverAs.
        pi.sendUserMessage(`${PARENT_OPEN}${command.text}${PARENT_CLOSE}`, { deliverAs: "steer" });
        break;
      case "answer":
        questions.answer(command.questionId, command.text);
        break;
      case "interrupt":
        ctx.abort();
        break;
    }
  };

  pi.on("session_start", (_event, context) => {
    ctx = context;
    const messages = context.sessionManager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    lastText = finalOutput(messages);
    emit({ _tag: "MetaChanged", meta: currentMeta(context) });
    emitUsage(context);
    // Start after startup finishes so the first prompt runs in a ready session.
    setTimeout(() => {
      stopInbox ??= tailJsonl(paths.inbox, (value) => {
        if (isParentCommand(value)) handle(value);
      });
    }, 0);
    // The parent stops its children when it exits; this covers a parent that dies without cleanup.
    const parentPid = Number(fs.readFileSync(paths.parentPid, "utf8"));
    parentWatch ??= setInterval(() => {
      if (processIsRunning(parentPid)) return;
      clearInterval(parentWatch);
      context.abort();
      context.shutdown();
    }, PARENT_CHECK_MS);
  });
  pi.on("input", (event) => {
    if (reported || !event.text.startsWith(PARENT_OPEN)) return;
    reported = true;
    emit({ _tag: "RunStarted" });
  });
  pi.on("message_update", (event) => translateActivity(event, emit));
  pi.on("tool_execution_start", (event) => translateActivity(event, emit));
  pi.on("tool_execution_update", (event) => translateActivity(event, emit));
  pi.on("tool_execution_end", (event) => translateActivity(event, emit));
  pi.on("message_end", (event, context) => {
    translateActivity(event, emit);
    if (messageRole(event.message) !== "assistant") return;
    lastAssistant = event.message as AssistantMessage;
    lastText = assistantText(lastAssistant) || lastText;
    emitUsage(context);
    emit({ _tag: "MetaChanged", meta: currentMeta(context) });
  });
  pi.on("agent_settled", (event) => {
    if (!reported) return;
    reported = false;
    const partialText = lastText || undefined;
    const partial = partialText === undefined ? {} : { partialText };
    if (event.aborted) {
      emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted", ...partial } });
    } else if (lastAssistant?.stopReason === "error") {
      emit({
        _tag: "RunSettled",
        outcome: { _tag: "Failed", errorText: lastAssistant.errorMessage ?? "Run failed", ...partial },
      });
    } else {
      emit({ _tag: "RunSettled", outcome: { _tag: "Completed", finalText: lastText } });
    }
  });
  pi.on("session_shutdown", (event) => {
    stopInbox?.();
    stopInbox = undefined;
    clearInterval(parentWatch);
    parentWatch = undefined;
    questions.close();
    if (reported && event.reason === "quit")
      emit({ _tag: "RunSettled", outcome: { _tag: "Failed", errorText: "The subagent's pi exited." } });
    ctx = undefined;
  });
}
