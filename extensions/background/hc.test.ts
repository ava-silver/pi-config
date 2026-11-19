/**
 * hc backend through a real manager runtime. A fake `hc` records calls and,
 * on `run`, starts a scripted child that speaks the channel protocol.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ManagedRuntime } from "effect";
import { type HcRunner, makeHcBackend } from "./src/backends/hc.ts";
import { appendLine, CHANNEL_ENV, channelPaths, isParentCommand, tailJsonl } from "./src/channel.ts";
import type { SpawnTask, SubagentEvent } from "./src/domain.ts";
import { makeSubagentManagerLayer, SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

interface FakeHc {
  readonly hc: HcRunner;
  readonly calls: string[][];
  /** Make every terminal report as finished, as if its pi exited. */
  exitAll(): void;
  stop(): void;
}

/** Scripted child: answers each send with "echo: <text>"; "ASK" asks the parent first; compactions succeed. */
function startChild(dir: string, sessionFile: string) {
  const paths = channelPaths(dir);
  const emit = (event: SubagentEvent) => appendLine(paths.events, event);
  const settle = (finalText: string) => {
    emit({ _tag: "AssistantMessage", parts: [{ type: "text", text: finalText }] });
    emit({ _tag: "RunSettled", outcome: { _tag: "Completed", finalText } });
  };
  emit({ _tag: "MetaChanged", meta: { sessionFilePath: sessionFile } });
  return tailJsonl(paths.inbox, (value) => {
    if (!isParentCommand(value)) return;
    if (value.type === "send") {
      emit({ _tag: "RunStarted" });
      emit({ _tag: "UserMessage", text: value.text });
      if (value.text === "ASK") emit({ _tag: "QuestionAsked", question: { id: "q-1", text: "Which file?" } });
      else settle(`echo: ${value.text}`);
    } else if (value.type === "answer") {
      emit({ _tag: "QuestionClosed", questionId: value.questionId });
      settle(`answered: ${value.text}`);
    } else if (value.type === "compact") {
      appendLine(paths.events, { type: "compacted", id: value.id, tokensBefore: 80_000, estimatedTokensAfter: 8_000 });
    }
  });
}

function fakeHc(): FakeHc {
  const calls: string[][] = [];
  const children: Array<() => void> = [];
  let live = true;
  let terminals = 0;
  const hc: HcRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "run") {
      const env = args.find((arg) => arg.startsWith(`${CHANNEL_ENV}=`));
      assert.ok(env, "the child gets its channel");
      live = true;
      children.push(startChild(env.slice(CHANNEL_ENV.length + 1), "/tmp/child-session.jsonl"));
      return JSON.stringify({ address: `t${++terminals}` });
    }
    if (args[0] === "get") return JSON.stringify({ state: live ? "live" : "finished" });
    return "{}";
  };
  return {
    hc,
    calls,
    exitAll: () => {
      live = false;
    },
    stop: () => children.forEach((stop) => stop()),
  };
}

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "Fix the widget",
    cwd: process.cwd(),
    parent: { parentCwd: process.cwd(), projectTrusted: true },
  };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    fake: FakeHc,
    runtime: ManagedRuntime.ManagedRuntime<SubagentManager, never>,
  ) => Promise<void>,
) {
  const fake = fakeHc();
  const backend = makeHcBackend({ hc: fake.hc, piCommand: ["pi"] });
  const runtime = ManagedRuntime.make(makeSubagentManagerLayer(backend.spawn, backend.resume));
  try {
    await run(await runtime.runPromise(SubagentManager), fake, runtime);
  } finally {
    await runtime.dispose();
    fake.stop();
  }
}

test("an hc subagent runs its prompt in a new terminal and is removed with the parent", async () => {
  const fake = fakeHc();
  const backend = makeHcBackend({ hc: fake.hc, piCommand: ["pi"] });
  const runtime = ManagedRuntime.make(makeSubagentManagerLayer(backend.spawn, backend.resume));
  const manager = await runtime.runPromise(SubagentManager);
  const snap = await runTool(runtime, manager.spawn(task("Say hello")));
  await runTool(runtime, manager.waitFor([snap.id]));

  const done = manager.view.get(snap.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.finalText, "echo: Say hello");
  assert.equal(done?.meta.sessionFilePath, "/tmp/child-session.jsonl");

  await runtime.dispose();
  fake.stop();
  assert.deepEqual(
    fake.calls.filter(([command]) => command === "kill" || command === "rm"),
    [
      ["kill", "t1"],
      ["rm", "t1"],
    ],
  );
});

test("ask_parent questions reach the parent and answers reach the child", async () => {
  await withManager(async (manager, _fake, runtime) => {
    const snap = await runTool(runtime, manager.spawn(task("ASK")));
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.pendingQuestions[0]?.text, "Which file?");

    const result = await runTool(runtime, manager.message(snap.id, "src/widget.ts"));
    assert.equal(result.kind, "answered");
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.finalText, "answered: src/widget.ts");
  });
});

test("messaging an hc subagent whose pi exited starts it again on its session file", async () => {
  await withManager(async (manager, fake, runtime) => {
    const snap = await runTool(runtime, manager.spawn(task("first")));
    await runTool(runtime, manager.waitFor([snap.id]));
    fake.exitAll();

    await runTool(runtime, manager.message(snap.id, "second"));
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.finalText, "echo: second");
    const runs = fake.calls.filter(([command]) => command === "run");
    assert.equal(runs.length, 2);
    assert.ok(runs[1]?.join(" ").includes("--session /tmp/child-session.jsonl"));
  });
});

test("compacting a live hc subagent uses its terminal and does not start a run", async () => {
  await withManager(async (manager, fake, runtime) => {
    const snap = await runTool(runtime, manager.spawn(task("first")));
    await runTool(runtime, manager.waitFor([snap.id]));

    const [result] = await runTool(runtime, manager.compact([snap.id], "Keep the widget plan"));
    assert.equal(result?.tokensBefore, 80_000);
    assert.equal(manager.view.get(snap.id)?.status, "done");
    assert.equal(fake.calls.filter(([command]) => command === "run").length, 1);
  });
});

test("compacting an hc subagent whose pi exited starts it on its session file", async () => {
  await withManager(async (manager, fake, runtime) => {
    const snap = await runTool(runtime, manager.spawn(task("first")));
    await runTool(runtime, manager.waitFor([snap.id]));
    fake.exitAll();

    const [result] = await runTool(runtime, manager.compact([snap.id]));
    assert.equal(result?.estimatedTokensAfter, 8_000);
    assert.equal(manager.view.get(snap.id)?.status, "done");
    const runs = fake.calls.filter(([command]) => command === "run");
    assert.equal(runs.length, 2);
    assert.ok(runs[1]?.join(" ").includes("--session /tmp/child-session.jsonl"));
  });
});

test("restored hc subagents replay their session file without starting a terminal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-restore-"));
  const sessionFile = path.join(dir, "session.jsonl");
  const header = { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: process.cwd() };
  const message = (id: string, parentId: string | null, body: Record<string, unknown>) => ({
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: body,
  });
  fs.writeFileSync(
    sessionFile,
    [
      header,
      message("a", null, { role: "user", content: "Say hello", timestamp: 1 }),
      message("b", "a", {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "x",
        provider: "x",
        model: "x",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0.5 } },
        stopReason: "stop",
        timestamp: 2,
      }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  try {
    await withManager(async (manager, fake, runtime) => {
      await runTool(
        runtime,
        manager.restore(
          [
            {
              version: 1,
              id: "sa-3",
              title: "Fix the widget",
              prompt: "Say hello",
              cwd: process.cwd(),
              status: "done",
              createdAt: 1,
              finalText: "hello",
              contextTokens: 12_000,
              meta: { sessionFilePath: sessionFile, contextWindow: 1_000_000 },
            },
          ],
          { parentCwd: process.cwd(), projectTrusted: true },
        ),
      );
      // The restored transcript is folded in asynchronously.
      for (let i = 0; i < 50 && !manager.view.get("sa-3")?.transcript.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const restored = manager.view.get("sa-3");
      assert.deepEqual(
        restored?.transcript.map((item) => item.kind),
        ["user", "assistant"],
      );
      assert.equal(restored?.cost, 0.5);
      assert.deepEqual(restored?.usage, { tokens: 12_000, contextWindow: 1_000_000 });
      assert.equal(fake.calls.filter(([command]) => command === "run").length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
