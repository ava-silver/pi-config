/**
 * Translation from pi agent events and messages to normalized SubagentEvents.
 * Shared by the in-process backend and the child reporter of the hc backend,
 * which see the same event shapes (AgentSessionEvent and extension events).
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { SubagentEvent, TranscriptPart } from "../domain.ts";

export type Emit = (event: SubagentEvent) => void;

export function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult") return role;
  return undefined;
}

export function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Final assistant text output (last assistant message with text), v1 semantics. */
export function finalOutput(messages: ReadonlyArray<unknown>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) !== "assistant") continue;
    const text = assistantText(msg as AssistantMessage);
    if (text) return text;
  }
  return "";
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The argument key that best summarizes a call for known tool types. */
const TOOL_SUMMARY_KEY = {
  bash: "command",
  read: "path",
  write: "path",
  edit: "path",
  fetch_content: "url",
  web_search: "query",
  grep: "pattern",
  find: "pattern",
  source_check: "claim",
  subagent_spawn: "name",
  subagent_wait: "ids",
  subagent_cancel: "ids",
  subagent_list: null,
  workflow: null,
  ask_user: "question",
  ask_parent: "question",
} satisfies Record<string, string | null>;

/**
 * Human-readable one-line preview of tool arguments. Extracts the most
 * meaningful argument for known tools; falls back to the first string value
 * found, then raw JSON.
 */
export function toolCallPreview(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return safeJson(args);
  const obj = args as Record<string, unknown>;

  const key = Object.hasOwn(TOOL_SUMMARY_KEY, toolName)
    ? TOOL_SUMMARY_KEY[toolName as keyof typeof TOOL_SUMMARY_KEY]
    : undefined;

  if (key === null) return undefined; // known, no meaningful args to show

  const target = key !== undefined ? obj[key] : undefined;
  if (typeof target === "string") {
    const first = target.split("\n")[0]?.trim() ?? "";
    return first.slice(0, 300) || undefined;
  }
  if (Array.isArray(target)) {
    const items = (target as unknown[]).filter((v): v is string => typeof v === "string");
    return items.join(", ").slice(0, 300) || undefined;
  }

  // Unknown tool: use the first non-empty string value as a best-effort preview.
  for (const val of Object.values(obj)) {
    if (typeof val === "string" && val.trim()) {
      return (val.split("\n")[0] ?? "").trim().slice(0, 300);
    }
  }

  return safeJson(args);
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
export function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

export function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
      });
    } else if (part.type === "toolCall") {
      const argsPreview = toolCallPreview(part.name, part.arguments);
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        ...(argsPreview === undefined ? {} : { argsPreview }),
      });
    }
  }
  return parts;
}

export function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Transcript-building events common to AgentSessionEvent and extension events. */
export type ActivityEvent =
  | {
      type: "message_update";
      assistantMessageEvent: { type: string; delta?: string };
    }
  | { type: "message_end"; message: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

/** Emit the transcript events for one activity event. */
export function translateActivity(event: ActivityEvent, emit: Emit) {
  switch (event.type) {
    case "message_update": {
      const { type, delta } = event.assistantMessageEvent;
      if ((type === "text_delta" || type === "thinking_delta") && typeof delta === "string")
        emit({ _tag: "AssistantDelta", kind: type === "text_delta" ? "text" : "thinking", delta });
      break;
    }
    case "message_end": {
      const role = messageRole(event.message);
      if (role === "user") {
        const text = userText(event.message as Message);
        if (text.trim()) emit({ _tag: "UserMessage", text });
      } else if (role === "assistant") {
        emit({ _tag: "AssistantMessage", parts: assistantParts(event.message as AssistantMessage) });
      }
      break;
    }
    case "tool_execution_start": {
      const argsPreview = toolCallPreview(event.toolName, event.args);
      emit({
        _tag: "ToolStart",
        toolId: event.toolCallId,
        name: event.toolName,
        ...(argsPreview === undefined ? {} : { argsPreview }),
      });
      break;
    }
    case "tool_execution_update": {
      const outputPreview = toolPreview(event.partialResult);
      emit({
        _tag: "ToolUpdate",
        toolId: event.toolCallId,
        ...(outputPreview === undefined ? {} : { outputPreview }),
      });
      break;
    }
    case "tool_execution_end": {
      const outputPreview = toolPreview(event.result);
      emit({
        _tag: "ToolEnd",
        toolId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        ...(outputPreview === undefined ? {} : { outputPreview }),
      });
      break;
    }
  }
}

/** Replay a restored session's messages as transcript events. */
export function replayTranscript(messages: ReadonlyArray<unknown>, emit: Emit) {
  for (const message of messages) {
    const role = messageRole(message);
    if (role === "user") {
      const text = userText(message as Message);
      if (text.trim()) emit({ _tag: "UserMessage", text });
    } else if (role === "assistant") {
      emit({ _tag: "AssistantMessage", parts: assistantParts(message as AssistantMessage) });
    }
  }
  emit({ _tag: "OutputRestored", finalText: finalOutput(messages) });
}

export function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}
