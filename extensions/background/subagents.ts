/**
 * Subagents — spawn background pi subagents, each a headless in-process
 * agent session with its own context window.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, name, working_dir,
 *   model, reasoning_effort). Max 16 running at once.
 * - subagent_wait: block until the listed subagents settle or ask a question.
 * - subagent_answer: answer a subagent's pending question.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/background` opens the shared task picker and takeover view.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatElapsed, latestText, REASONING_EFFORTS, type SubagentSnapshot } from "./src/domain.ts";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import { registerBackgroundCost, registerTransientSegment } from "../shared/footer-segments.ts";
import { resolveStandaloneChildProjectTrust } from "../shared/child-session.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentQuestionMessage,
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_ANSWER_PARAMETER_DESCRIPTIONS,
  SUBAGENT_ANSWER_TOOL_DESCRIPTION,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import { createSubagentRuntime, runTool, type SubagentRuntime } from "./src/runtime.ts";
import { openTakeoverView } from "./src/ui/takeover.ts";
import type { BackgroundHub } from "./src/hub.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    snap.meta.modelLabel ?? "?",
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  const status = snap.pendingQuestions.length > 0 ? "waiting for answer" : snap.status;
  return `${snap.id} [${status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(snap: SubagentSnapshot, maxBytes = SUBAGENT_OUTPUT_MAX_BYTES): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

interface SubagentController {
  getRuntime(): SubagentRuntime;
  getManager(): Promise<SubagentManagerShape>;
  getView(): SubagentManagerShape["view"] | undefined;
  consumeResults(ids: string[]): void;
  start(ctx: ExtensionContext): void;
  shutdown(): Promise<void>;
  flushResults(): void;
}

function createSubagentController(pi: ExtensionAPI): SubagentController {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let managerView: SubagentManagerShape["view"] | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  let costKey: string | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());
  const updateStatus = (manager: SubagentManagerShape) => {
    const subs = manager.view.list();
    if (costKey)
      registerBackgroundCost(
        costKey,
        subs.reduce((total, snap) => total + snap.cost, 0),
      );
    if (!ui) return;
    if (subs.length === 0) {
      registerTransientSegment("subagents", null);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (done > 0) parts.push(`${done} done`);
    if (failed > 0) parts.push(`${failed} failed`);
    const bg = failed > 0 ? "#e78284" : running > 0 ? "#81c8be" : "#a6d189";
    registerTransientSegment("subagents", {
      text: parts.join(" · "),
      bg,
      fg: "#1e2030",
    });
  };
  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          ...(snap.errorText === undefined ? {} : { errorText: snap.errorText }),
          output: truncatedOutput(snap),
        }),
        display: true,
        details: { id: snap.id, title: snap.title, status: snap.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };
  const deliverQuestion = (snap: SubagentSnapshot, question: SubagentSnapshot["pendingQuestions"][number]) => {
    pi.sendMessage(
      {
        customType: "subagent-question",
        content: buildSubagentQuestionMessage({
          id: snap.id,
          title: snap.title,
          question: question.text,
        }),
        display: true,
        details: { id: snap.id, title: snap.title, questionId: question.id },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  };
  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        manager.view.setOnQuestion(deliverQuestion);
        managerView = manager.view;
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  return {
    getRuntime,
    getManager,
    getView: () => managerView,
    consumeResults: (ids) => resultDelivery.consume(ids),
    flushResults,
    start(ctx) {
      sessionContext = ctx;
      costKey = `subagents:${ctx.sessionManager.getSessionId()}`;
      if (ctx.hasUI) ui = ctx.ui;
    },
    async shutdown() {
      sessionContext = undefined;
      resultDelivery.clear();
      unsubStatus?.();
      unsubStatus = undefined;
      registerTransientSegment("subagents", null);
      if (costKey) registerBackgroundCost(costKey, null);
      costKey = undefined;
      const closing = runtime;
      runtime = undefined;
      managerPromise = undefined;
      managerView = undefined;
      await closing?.dispose();
    },
  };
}

function registerSubagentLifecycle(pi: ExtensionAPI, background: BackgroundHub, controller: SubagentController) {
  let unregisterProvider: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    controller.start(ctx);
    unregisterProvider?.();
    unregisterProvider = background.registerProvider("subagents", {
      label: "Subagents",
      list() {
        return (controller.getView()?.list() ?? []).map((snap) => ({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          elapsed: () => formatElapsed(snap),
          meta: () => {
            const parts: string[] = [];
            if (snap.meta.modelLabel) parts.push(snap.meta.modelLabel);
            const util = formatContextUtilization(snap.usage);
            if (util) parts.push(util);
            return parts;
          },
        }));
      },
      subscribe(cb) {
        return controller.getView()?.subscribe(cb) ?? (() => {});
      },
      async openDetail(id, viewContext) {
        const manager = await controller.getManager();
        await openTakeoverView(id, viewContext, manager.view);
      },
      kill(id) {
        controller.getView()?.requestAbort(id);
      },
    });
  });
  pi.on("agent_settled", () => controller.flushResults());
  pi.on("session_shutdown", async () => {
    unregisterProvider?.();
    unregisterProvider = undefined;
    await controller.shutdown();
  });
}

function registerSpawnTool(pi: ExtensionAPI, controller: SubagentController) {
  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    renderCall(args, theme) {
      const lines = [
        theme.fg("toolTitle", "subagent_spawn") + (args.name ? " " + theme.fg("dim", args.name) : ""),
        ...(args.prompt ? [theme.fg("text", args.prompt)] : []),
        ...(args.working_dir ? [theme.fg("muted", `cwd: ${args.working_dir}`)] : []),
        ...(args.model ? [theme.fg("muted", `model: ${args.model}`)] : []),
        ...(args.reasoning_effort ? [theme.fg("muted", `effort: ${args.reasoning_effort}`)] : []),
      ];
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await controller.getManager();
      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
        throw new Error(`working_dir is not a directory: ${cwd}`);
      const title = params.name.trim().slice(0, 160) || "subagent";
      const snap = await runTool(
        controller.getRuntime(),
        manager.spawn({
          prompt: params.prompt,
          title,
          cwd,
          ...(params.model === undefined ? {} : { model: params.model }),
          ...(params.reasoning_effort === undefined ? {} : { reasoningEffort: params.reasoning_effort }),
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: resolveStandaloneChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            ...(ctx.model
              ? {
                  inheritedModel: {
                    provider: ctx.model.provider,
                    id: ctx.model.id,
                  },
                }
              : {}),
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          model: snap.meta.modelLabel,
        },
      };
    },
  });
}

function registerWaitTool(pi: ExtensionAPI, controller: SubagentController) {
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    renderCall(args, theme) {
      const label = args.ids?.join(", ") ?? "";
      return new Text(theme.fg("toolTitle", "subagent_wait") + (label ? " " + theme.fg("dim", label) : ""), 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await controller.getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0) throw new Error("Provide at least one subagent id.");
      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0)
        throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`);
      await runTool(
        controller.getRuntime(),
        manager.waitFor(ids, (pending) =>
          onUpdate?.({
            content: [{ type: "text", text: `Waiting for ${pending.join(", ")}...` }],
            details: { pending },
          }),
        ),
        {
          ...(signal === undefined ? {} : { signal }),
          interruptMessage: "Wait aborted. Subagents keep running.",
        },
      );
      controller.consumeResults(ids);
      return waitResult(manager, ids);
    },
  });
}

function waitResult(manager: SubagentManagerShape, ids: string[]) {
  const sections: string[] = [];
  let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
  for (const id of ids) {
    const snap = manager.view.get(id);
    if (!snap) {
      sections.push(`## ${id}\n\n(no longer tracked)`);
      continue;
    }
    const question = snap.pendingQuestions[0];
    const verb = question
      ? "is waiting for an answer"
      : snap.status === "error"
        ? "failed"
        : snap.status === "running"
          ? "is still running"
          : "finished";
    let section = `## ${snap.id} "${snap.title}" ${verb}`;
    if (snap.errorText) section += `\nError: ${snap.errorText}`;
    const outputBudget = Math.max(
      512,
      Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - Buffer.byteLength(section, "utf8") - 2),
    );
    section += question
      ? `\n\nQuestion: ${question.text}\n\nAnswer with subagent_answer({ id: "${snap.id}", answer: "..." }).`
      : `\n\n${truncatedOutput(snap, outputBudget)}`;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (sectionBytes > remainingBytes) {
      sections.push(`## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`);
      break;
    }
    sections.push(section);
    remainingBytes -= sectionBytes;
  }
  const bounded = truncateHead(sections.join("\n\n---\n\n"), {
    maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
    maxLines: DEFAULT_MAX_LINES,
  });
  const text = bounded.truncated
    ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
    : bounded.content;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      results: ids.map((id) => {
        const snap = manager.view.get(id);
        return { id, title: snap?.title, status: snap?.status };
      }),
    },
  };
}

function registerSimpleSubagentTools(pi: ExtensionAPI, controller: SubagentController) {
  pi.registerTool({
    name: "subagent_answer",
    label: "Answer Subagent",
    description: SUBAGENT_ANSWER_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_ANSWER_PARAMETER_DESCRIPTIONS.id,
      }),
      answer: Type.String({
        description: SUBAGENT_ANSWER_PARAMETER_DESCRIPTIONS.answer,
      }),
    }),
    renderCall(args, theme) {
      const header = theme.fg("toolTitle", "subagent_answer") + (args.id ? " " + theme.fg("dim", String(args.id)) : "");
      return new Text([header, ...(args.answer ? [theme.fg("text", args.answer)] : [])].join("\n"), 0, 0);
    },
    async execute(_toolCallId, params) {
      const manager = await controller.getManager();
      const answer = params.answer.trim();
      if (!answer) throw new Error("Provide a non-empty answer.");
      const question = await runTool(controller.getRuntime(), manager.answer(params.id, answer));
      return {
        content: [{ type: "text", text: `Answered ${params.id}: ${question.text}` }],
        details: {
          id: params.id,
          questionId: question.id,
          question: question.text,
          answer,
        },
      };
    },
  });
  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    renderCall(args, theme) {
      const label = args.ids?.join(", ") ?? "";
      return new Text(theme.fg("toolTitle", "subagent_cancel") + (label ? " " + theme.fg("dim", label) : ""), 0, 0);
    },
    async execute(_toolCallId, params) {
      const manager = await controller.getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0) throw new Error("Provide at least one subagent id.");
      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0)
        throw new Error(`Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`);
      const report = await runTool(controller.getRuntime(), manager.cancel(ids));
      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });
  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", "subagent_check") + (args.id ? " " + theme.fg("dim", String(args.id)) : ""),
        0,
        0,
      );
    },
    async execute(_toolCallId, params) {
      const manager = await controller.getManager();
      const snap = manager.view.get(params.id);
      if (!snap) {
        const known = manager.view.list().map((s) => s.id);
        throw new Error(`Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`);
      }
      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;
      const question = snap.pendingQuestions[0];
      if (question) text += `\nPending question: ${question.text}`;
      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") text += "\n\n(no text output yet)";
      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });
  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "subagent_list"), 0, 0);
    },
    async execute() {
      const manager = await controller.getManager();
      const subs = manager.view.list();
      const text = subs.length === 0 ? "No subagents." : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            status: snap.status,
          })),
        },
      };
    },
  });
}

function registerSubagentMessageRenderers(pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-question", (message, _options, theme) => {
    const details = (message.details ?? {}) as {
      id?: string;
      title?: string;
    };
    const header =
      theme.fg("warning", "?") +
      " " +
      theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
      theme.fg("muted", ` · ${details.title ?? ""} · needs an answer`);
    const body = (typeof message.content === "string" ? message.content : "").split("\n").slice(1).join("\n").trim();
    const container = new Text(header, 0, 0);
    const md = new Markdown(body, 0, 0, getMarkdownTheme());
    return {
      render: (width: number) => [...container.render(width), ...md.render(width)],
      invalidate: () => {
        container.invalidate();
        md.invalidate();
      },
    };
  });
  pi.registerMessageRenderer("subagent-result", (message, _options, theme) => {
    const details = (message.details ?? {}) as {
      id?: string;
      title?: string;
      status?: string;
    };
    const failed = details.status === "error";
    const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "■");
    const header =
      `${icon} ` +
      theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
      theme.fg("muted", ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`);
    const body = (typeof message.content === "string" ? message.content : "").split("\n").slice(1).join("\n").trim();
    const container = new Text(header, 0, 0);
    const md = new Markdown(body, 0, 0, getMarkdownTheme());
    return {
      render: (width: number) => [...container.render(width), ...md.render(width)],
      invalidate: () => {
        container.invalidate();
        md.invalidate();
      },
    };
  });
}

export function setupSubagents(pi: ExtensionAPI, background: BackgroundHub) {
  const controller = createSubagentController(pi);
  registerSubagentLifecycle(pi, background, controller);
  registerSpawnTool(pi, controller);
  registerWaitTool(pi, controller);
  registerSimpleSubagentTools(pi, controller);
  registerSubagentMessageRenderers(pi);
}
