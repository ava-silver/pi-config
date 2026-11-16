/**
 * Child reporter through a fake extension API: which turns reach the parent
 * and how parent messages reach the model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendLine, channelPaths, isSubagentEvent } from "./src/channel.ts";
import { setupSubagentChild } from "./src/child.ts";
import type { SubagentEvent } from "./src/domain.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function fakeChild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-test-"));
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  const ctx = {
    model: undefined,
    sessionManager: { getSessionFile: () => "/tmp/s.jsonl", getBranch: () => [], getEntries: () => [] },
    getContextUsage: () => undefined,
    isIdle: () => true,
    abort: () => {},
  } as unknown as ExtensionContext;
  const fire = (type: string, event: Record<string, unknown> = {}) =>
    (handlers.get(type) ?? []).forEach((handler) => handler({ type, ...event }, ctx));
  const pi = {
    on: (type: string, handler: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), handler]),
    registerTool: () => {},
    sendUserMessage: (text: string) => {
      sent.push(text);
      fire("input", { text, source: "extension" });
    },
  } as unknown as ExtensionAPI;
  setupSubagentChild(pi, dir);
  fire("session_start");
  const paths = channelPaths(dir);
  const events = (): SubagentEvent[] =>
    fs
      .readFileSync(paths.events, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isSubagentEvent);
  const turn = (text: string) => {
    fire("agent_start");
    fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
    fire("agent_settled", { aborted: false });
  };
  /** Deliver a parent message through the inbox, as the parent backend does. */
  const fromParent = async (text: string) => {
    appendLine(paths.inbox, { type: "send", text });
    const before = sent.length;
    for (let i = 0; i < 100 && sent.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  return {
    sent,
    events,
    fire,
    turn,
    fromParent,
    dispose: () => {
      fire("session_shutdown", { reason: "quit" });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const runEvents = (events: SubagentEvent[]) =>
  events.filter((event) => event._tag === "RunStarted" || event._tag === "RunSettled");

test("a turn the user starts in the child is not reported to the parent as a run", () => {
  const child = fakeChild();
  try {
    child.fire("input", { text: "rename the helper", source: "interactive" });
    child.turn("renamed");
    assert.deepEqual(runEvents(child.events()), []);
    assert.ok(child.events().some((event) => event._tag === "AssistantMessage"));
  } finally {
    child.dispose();
  }
});

test("parent messages reach the model labeled, and their turns are reported", async () => {
  const child = fakeChild();
  try {
    await child.fromParent("fix the test");
    assert.deepEqual(child.sent, ["<parent_agent>\nfix the test\n</parent_agent>"]);
    child.turn("fixed");
    assert.deepEqual(runEvents(child.events()), [
      { _tag: "RunStarted" },
      { _tag: "RunSettled", outcome: { _tag: "Completed", finalText: "fixed" } },
    ]);
  } finally {
    child.dispose();
  }
});

test("a parent message that steers a user's turn makes that turn reported", async () => {
  const child = fakeChild();
  try {
    child.fire("input", { text: "look at x.rs", source: "interactive" });
    child.fire("agent_start");
    await child.fromParent("also check y.rs");
    child.fire("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "both fine" }], stopReason: "stop" },
    });
    child.fire("agent_settled", { aborted: false });
    assert.deepEqual(runEvents(child.events()), [
      { _tag: "RunStarted" },
      { _tag: "RunSettled", outcome: { _tag: "Completed", finalText: "both fine" } },
    ]);
  } finally {
    child.dispose();
  }
});
