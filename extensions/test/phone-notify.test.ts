import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { promptNotification, runNotification } from "../phone-notify.ts";

const assistant = (overrides: Partial<AssistantMessage>): AssistantMessage =>
  ({ role: "assistant", content: [], stopReason: "stop", ...overrides }) as AssistantMessage;

test("a finished run shows the first line of the reply", () => {
  const last = assistant({ content: [{ type: "text", text: "\nAll set.\nMore detail." }] });
  assert.deepEqual(runNotification("/work/app", last), {
    title: "app: done",
    message: "All set.",
    priority: "default",
  });
});

test("a failed run is high priority and shows the error", () => {
  const last = assistant({ stopReason: "error", errorMessage: "429 rate limited\nretry later" });
  assert.deepEqual(runNotification("/work/app", last), {
    title: "app: error",
    message: "429 rate limited",
    priority: "high",
  });
});

test("a blocking prompt is high priority and shows its title", () => {
  assert.deepEqual(promptNotification("/work/app", "Pick a model"), {
    title: "app: needs you",
    message: "Pick a model",
    priority: "high",
  });
});
