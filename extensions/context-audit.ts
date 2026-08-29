import { getEncoding } from "js-tiktoken";
import {
  estimateTokens,
  sessionEntryToContextMessages,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const REPORT_FILE = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi", "context-audit.html");

type ContextTool = {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  sourceInfo: { path: string; source: string };
};

export type ContextAuditInput = {
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  systemPrompt: string;
  options: BuildSystemPromptOptions;
  activeToolNames: string[];
  tools: ContextTool[];
  contextEntries: SessionEntry[];
};

const tokenizer = getEncoding("o200k_base");

function tokens(value: unknown): number {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text === undefined ? 0 : tokenizer.encode(text).length;
  } catch {
    return 0;
  }
}

function count(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function details(summary: string, content: unknown, metadata = ""): string {
  return `<details><summary>${escapeHtml(summary)}${metadata ? `<span>${escapeHtml(metadata)}</span>` : ""}</summary><pre>${escapeHtml(content)}</pre></details>`;
}

type Metric = { label: string; value: number; detail?: string };

function groupMetrics(items: Metric[]): Metric[] {
  return [
    ...items.reduce((groups, item) => {
      const current = groups.get(item.label) ?? { value: 0, count: 0 };
      groups.set(item.label, { value: current.value + item.value, count: current.count + 1 });
      return groups;
    }, new Map<string, { value: number; count: number }>()),
  ]
    .map(([label, group]) => ({
      label,
      value: group.value,
      detail: `${group.count} item${group.count === 1 ? "" : "s"}`,
    }))
    .sort((left, right) => right.value - left.value);
}

function stackedBar(items: Metric[]): string {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  return `<div class="stacked">${items
    .map(
      (item, index) =>
        `<div style="width:${((item.value / total) * 100).toFixed(2)}%;--color:var(--chart-${(index % 6) + 1})" title="${escapeHtml(`${item.label}: ${count(item.value)} estimated tokens`)}"></div>`,
    )
    .join("")}</div><div class="legend">${items
    .map(
      (item, index) =>
        `<span><i style="--color:var(--chart-${(index % 6) + 1})"></i>${escapeHtml(item.label)} <strong>${count(item.value)}</strong></span>`,
    )
    .join("")}</div>`;
}

function barChart(items: Metric[], limit = 12): string {
  const shown = items.toSorted((left, right) => right.value - left.value).slice(0, limit);
  const maximum = shown[0]?.value || 1;
  return `<div class="bars">${shown
    .map(
      (item) =>
        `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.detail ?? "")}</small></div><div class="bar-track"><i style="width:${((item.value / maximum) * 100).toFixed(2)}%"></i></div><strong>${count(item.value)}</strong></div>`,
    )
    .join("")}</div>`;
}

function sourceLabel(source: string): string {
  return source === "auto" ? "local" : source;
}

function entryLabel(entry: SessionEntry): string {
  if (entry.type === "message") {
    return entry.message.role === "toolResult" ? `Tool result: ${entry.message.toolName}` : entry.message.role;
  }
  if (entry.type === "custom_message") return `Extension message: ${entry.customType}`;
  if (entry.type === "compaction") return "Compaction summary";
  if (entry.type === "branch_summary") return "Branch summary";
  return entry.type;
}

export function contextAuditHtml(input: ContextAuditInput): string {
  const activeNames = new Set(input.activeToolNames);
  const activeTools = input.tools.filter((tool) => activeNames.has(tool.name));
  const inactiveTools = input.tools.filter((tool) => !activeNames.has(tool.name));
  const modelSkills = (input.options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
  const manualSkills = (input.options.skills ?? []).filter((skill) => skill.disableModelInvocation);
  const messages = input.contextEntries.flatMap((entry) =>
    sessionEntryToContextMessages(entry).map((message) => ({ entry, message })),
  );
  const toolTokens = activeTools.reduce((sum, tool) => sum + tokens(tool), 0);
  const messageTokens = messages.reduce((sum, item) => sum + estimateTokens(item.message), 0);
  const usage = input.contextUsage;
  const usageLabel = usage
    ? `${usage.tokens === null ? "Unknown" : `${count(usage.tokens)} tokens`} / ${count(usage.contextWindow)}${usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`}`
    : "Unavailable";
  const generated = new Date().toLocaleString();
  const topLevelMetrics: Metric[] = [
    { label: "System prompt", value: tokens(input.systemPrompt) },
    { label: "Tool definitions", value: toolTokens },
    { label: "Conversation", value: messageTokens },
  ];
  const knownPromptMetrics: Metric[] = [
    ...(input.options.contextFiles ?? []).map((file) => ({
      label: file.path,
      value: tokens(file.content),
      detail: "context file",
    })),
    ...modelSkills.map((skill) => ({
      label: skill.name,
      value: tokens(skill.description),
      detail: "skill catalog description",
    })),
    ...(input.options.customPrompt === undefined
      ? []
      : [{ label: "Custom base prompt", value: tokens(input.options.customPrompt), detail: "replacement prompt" }]),
    { label: "Appended prompt", value: tokens(input.options.appendSystemPrompt ?? "") },
    { label: "Tool snippets", value: tokens(input.options.toolSnippets ?? {}) },
    { label: "Tool guidelines", value: tokens(input.options.promptGuidelines ?? []) },
  ].filter((metric) => metric.value > 0);
  const knownPromptTokens = knownPromptMetrics.reduce((sum, metric) => sum + metric.value, 0);
  const promptMetrics = [
    ...knownPromptMetrics,
    {
      label: input.options.customPrompt === undefined ? "Built-in prompt and formatting" : "Prompt formatting",
      value: Math.max(0, tokens(input.systemPrompt) - knownPromptTokens),
    },
  ].filter((metric) => metric.value > 0);
  const toolSourceMetrics = groupMetrics(
    activeTools.map((tool) => ({ label: sourceLabel(tool.sourceInfo.source), value: tokens(tool) })),
  );
  const toolMetrics = activeTools.map((tool) => ({
    label: tool.name,
    value: tokens(tool),
    detail: sourceLabel(tool.sourceInfo.source),
  }));
  const messageMetrics = messages.map(({ entry, message }, index) => ({
    label: `${index + 1}. ${entryLabel(entry)}`,
    value: estimateTokens(message),
  }));
  const messageGroupMetrics = groupMetrics(
    messages.map(({ entry, message }) => ({ label: entryLabel(entry), value: estimateTokens(message) })),
  );

  const contextFiles = input.options.contextFiles?.length
    ? input.options.contextFiles
        .map((file) => details(file.path, file.content, `${count(tokens(file.content))} estimated tokens`))
        .join("")
    : '<p class="empty">None</p>';
  const skills = modelSkills.length
    ? modelSkills
        .map(
          (skill) =>
            `<div class="item"><strong>${escapeHtml(skill.name)}</strong><span>${count(tokens(skill.description))} estimated description tokens</span><p>${escapeHtml(skill.description)}</p><code>${escapeHtml(skill.filePath)}</code></div>`,
        )
        .join("")
    : '<p class="empty">None</p>';
  const tools = activeTools.length
    ? activeTools
        .map((tool) =>
          details(
            tool.name,
            JSON.stringify(tool, null, 2),
            `${count(tokens(tool))} estimated JSON tokens · ${tool.sourceInfo.path}`,
          ),
        )
        .join("")
    : '<p class="empty">None</p>';
  const conversation = messages.length
    ? messages
        .map(({ entry, message }, index) =>
          details(
            `${index + 1}. ${entryLabel(entry)}`,
            JSON.stringify(message, null, 2),
            `${count(estimateTokens(message))} estimated tokens`,
          ),
        )
        .join("")
    : '<p class="empty">None</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi context audit</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f5; --panel: #fff; --text: #202124; --muted: #687078; --border: #d9ddd9; --accent: #1769aa; --code: #f2f4f3; --chart-1: #1769aa; --chart-2: #8e5bb7; --chart-3: #d87924; --chart-4: #29966f; --chart-5: #c34f65; --chart-6: #69757d; }
@media (prefers-color-scheme: dark) { :root { --bg: #111412; --panel: #191d1a; --text: #e8ece9; --muted: #a6afa8; --border: #353c37; --accent: #76b7eb; --code: #101310; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
main { width: min(1100px, calc(100% - 32px)); margin: 32px auto 64px; }
h1 { margin-bottom: 4px; font-size: 28px; }
h2 { margin: 36px 0 12px; font-size: 19px; }
p { margin: 6px 0; }
.subtitle, .empty, summary span, .item > span { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-top: 24px; }
.card, details, .item, .notice { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.card { padding: 16px; }
.card strong { display: block; margin-top: 4px; font-size: 18px; }
.card span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
details { margin: 8px 0; overflow: hidden; }
summary { cursor: pointer; padding: 12px 14px; font-weight: 600; }
summary span { float: right; margin-left: 16px; font-weight: 400; }
pre { max-height: 70vh; margin: 0; padding: 14px; overflow: auto; border-top: 1px solid var(--border); background: var(--code); white-space: pre-wrap; overflow-wrap: anywhere; }
.item { margin: 8px 0; padding: 12px 14px; }
.item > span { float: right; }
code { overflow-wrap: anywhere; }
.notice { margin-top: 28px; padding: 14px; border-left: 4px solid var(--accent); }
.visual { padding: 18px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.visual h3 { margin: 24px 0 10px; font-size: 14px; }
.visual h3:first-child { margin-top: 0; }
.stacked { display: flex; height: 34px; overflow: hidden; border-radius: 6px; background: var(--code); }
.stacked div { min-width: 2px; background: var(--color); }
.legend { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 12px; }
.legend span { color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 2px; background: var(--color); }
.legend strong { color: var(--text); font-weight: 600; }
.bars { display: grid; gap: 8px; }
.bar-row { display: grid; grid-template-columns: minmax(150px, 1.2fr) 3fr 72px; gap: 10px; align-items: center; }
.bar-label { min-width: 0; }
.bar-label span, .bar-label small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-label small { color: var(--muted); }
.bar-track { height: 12px; overflow: hidden; border-radius: 4px; background: var(--code); }
.bar-track i { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.bar-row > strong { text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 650px) { .bar-row { grid-template-columns: 1fr 70px; } .bar-track { grid-column: 1 / -1; grid-row: 2; } }
</style>
</head>
<body>
<main>
<h1>Pi context audit</h1>
<p class="subtitle">Generated ${escapeHtml(generated)}. This local report does not enter model context.</p>
<div class="cards">
<div class="card"><span>Context usage</span><strong>${escapeHtml(usageLabel)}</strong></div>
<div class="card"><span>System prompt</span><strong>${count(tokens(input.systemPrompt))} estimated tokens</strong></div>
<div class="card"><span>Active tools</span><strong>${activeTools.length} · ${count(toolTokens)} estimated tokens</strong></div>
<div class="card"><span>Conversation</span><strong>${messages.length} messages · ${count(messageTokens)} estimated tokens</strong></div>
</div>
<h2>What uses context</h2>
<div class="visual">
<h3>Top-level distribution</h3>
${stackedBar(topLevelMetrics)}
<h3>System prompt contributors</h3>
${barChart(promptMetrics)}
<h3>Tool definitions by source</h3>
${barChart(toolSourceMetrics)}
<h3>Largest active tool definitions</h3>
${barChart(toolMetrics)}
<h3>Conversation by type</h3>
${barChart(messageGroupMetrics)}
<h3>Largest conversation messages</h3>
${barChart(messageMetrics)}
</div>
<h2>Effective system prompt</h2>
${details("Full prompt", input.systemPrompt, `${count(tokens(input.systemPrompt))} estimated tokens`)}
<div class="item"><strong>Prompt construction</strong><p>Base: ${input.options.customPrompt === undefined ? "Pi built-in" : `custom (${count(tokens(input.options.customPrompt))} estimated tokens)`}<br>Appended: ${count(tokens(input.options.appendSystemPrompt ?? ""))} estimated tokens<br>Tool snippets: ${count(tokens(input.options.toolSnippets ?? {}))} estimated tokens<br>Tool guidelines: ${count(tokens(input.options.promptGuidelines ?? []))} estimated tokens</p></div>
<h2>Context files</h2>
${contextFiles}
<h2>Model-visible skill catalog</h2>
${skills}
<h2>Active tool definitions</h2>
${tools}
<h2>Conversation sent after compaction</h2>
${conversation}
<h2>Loaded but not model-visible</h2>
<div class="item"><strong>Inactive tools: ${inactiveTools.length}</strong><p>${escapeHtml(inactiveTools.map((tool) => tool.name).join(", ") || "None")}</p></div>
<div class="item"><strong>Manual-only skills: ${manualSkills.length}</strong><p>${escapeHtml(manualSkills.map((skill) => skill.name).join(", ") || "None")}</p></div>
<p class="notice">Per-turn extensions can alter the system prompt, messages, or provider payload after this command runs. System prompt and tool values use OpenAI's <code>o200k_base</code> tokenizer. Conversation values use Pi's provider-visible content estimate. Only context usage is provider-reported.</p>
</main>
</body>
</html>`;
}

export default function contextAuditExtension(pi: ExtensionAPI): void {
  pi.registerCommand("context-audit", {
    description: "Open a browser report of everything that can consume model context",
    handler: async (_args, ctx) => {
      const contextUsage = ctx.getContextUsage();
      const html = contextAuditHtml({
        ...(contextUsage ? { contextUsage } : {}),
        systemPrompt: ctx.getSystemPrompt(),
        options: ctx.getSystemPromptOptions(),
        activeToolNames: pi.getActiveTools(),
        tools: pi.getAllTools(),
        contextEntries: ctx.sessionManager.buildContextEntries(),
      });
      await mkdir(dirname(REPORT_FILE), { recursive: true });
      await writeFile(REPORT_FILE, html, { mode: 0o600 });
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const commandArgs = process.platform === "win32" ? ["/c", "start", "", REPORT_FILE] : [REPORT_FILE];
      const result = await pi.exec(command, commandArgs, { timeout: 5_000 });
      if (result.code !== 0) ctx.ui.notify(`Could not open ${REPORT_FILE}`, "error");
    },
  });
}
