import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { localServer, promptNotification, runNotification } from "../phone-notify.ts";

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

const healthServer = async (): Promise<{ url: URL; close: () => Promise<void> }> => {
  const server = createServer((_request, response) => response.end("{}"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/pi`),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

test("a running server is reused without starting another", async () => {
  const { url, close } = await healthServer();
  let starts = 0;
  const server = localServer(url, () => (starts++, new EventEmitter() as ChildProcess));
  await server.ensureRunning();
  await close();
  assert.equal(starts, 0);
});

test("a missing server is started once, even for concurrent callers, and stopped on request", async () => {
  const { url, close } = await healthServer();
  await close();
  let starts = 0;
  let killed = false;
  const child = Object.assign(new EventEmitter(), { kill: () => (killed = true) }) as unknown as ChildProcess;
  const server = localServer(url, () => (starts++, child), 0);
  await Promise.all([server.ensureRunning(), server.ensureRunning()]);
  server.stop();
  assert.deepEqual({ starts, killed }, { starts: 1, killed: true });
});
