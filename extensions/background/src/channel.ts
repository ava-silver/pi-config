/**
 * File channel between a parent and an hc-hosted child pi process.
 *
 * The directory named by `PI_SUBAGENT_CHANNEL` holds two append-only JSONL
 * files: `events.jsonl` (child -> parent SubagentEvents) and `inbox.jsonl`
 * (parent -> child commands). Each side tails the other's file from the
 * start, so a command written before the child starts is still delivered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SubagentEvent } from "./domain.ts";

export const CHANNEL_ENV = "PI_SUBAGENT_CHANNEL";
const POLL_MS = 150;

export type ParentCommand =
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "answer"; readonly questionId: string; readonly text: string }
  | { readonly type: "interrupt" };

export function channelPaths(dir: string) {
  return { events: path.join(dir, "events.jsonl"), inbox: path.join(dir, "inbox.jsonl") };
}

export function appendLine(file: string, value: unknown) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

const EVENT_TAGS = new Set<SubagentEvent["_tag"]>([
  "RunStarted",
  "RunSettled",
  "UserMessage",
  "AssistantDelta",
  "AssistantMessage",
  "ToolStart",
  "ToolUpdate",
  "ToolEnd",
  "QueueChanged",
  "QuestionAsked",
  "QuestionClosed",
  "OutputRestored",
  "UsageChanged",
  "MetaChanged",
]);

/** Shallow tag check: both ends run this extension, so the payload shape follows the tag. */
export function isSubagentEvent(value: unknown): value is SubagentEvent {
  const tag = (value as { _tag?: unknown } | null)?._tag;
  return typeof tag === "string" && EVENT_TAGS.has(tag as SubagentEvent["_tag"]);
}

export function isParentCommand(value: unknown): value is ParentCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "send":
      return typeof command.text === "string";
    case "answer":
      return typeof command.questionId === "string" && typeof command.text === "string";
    case "interrupt":
      return true;
    default:
      return false;
  }
}

/**
 * Poll `file` for complete new lines and pass each parsed JSON value to
 * `onValue`. Missing files are waited for; unparseable lines are skipped.
 * Returns a stop function.
 */
export function tailJsonl(file: string, onValue: (value: unknown) => void): () => void {
  let offset = 0;
  let partial = "";
  const decoder = new StringDecoder("utf8");
  const read = () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      const lines = (partial + decoder.write(buffer)).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        onValue(value);
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  read();
  const timer = setInterval(read, POLL_MS);
  return () => clearInterval(timer);
}
