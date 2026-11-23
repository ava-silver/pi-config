/** Rex host against a fake `rex` that models the session's blocks and windows. */

import assert from "node:assert/strict";
import test from "node:test";
import { type RexRunner, rexHost } from "./src/backends/rex.ts";

function fakeRex() {
  const blocks = new Map<string, { placement: "placed" | "detached"; label: string }>();
  const calls: string[] = [];
  let counter = 0;
  const rex: RexRunner = async (args) => {
    if (args[0] === "block") {
      blocks.delete(args[4] ?? "");
      return "";
    }
    const [method, payload] = [args[4] ?? "", JSON.parse(args[5] ?? "{}") as Record<string, any>];
    calls.push(method);
    if (method === "session.new_block") {
      const id = `b${++counter}`;
      blocks.set(id, { placement: "detached", label: payload.label });
      return JSON.stringify({ block_id: id });
    }
    if (method === "session.list_blocks")
      return JSON.stringify({ blocks: [...blocks].map(([block_id, b]) => ({ block_id, ...b })) });
    if (method === "session.new_window") {
      const id = `b${++counter}`;
      blocks.set(id, { placement: "placed", label: payload.layout.block.label });
      return JSON.stringify({ window_id: "w", block_ids: [id] });
    }
    if (method === "session.move_block") blocks.get(payload.block_id)!.placement = "placed";
    if (method === "session.list_clients") return JSON.stringify({ clients: [] });
    return "{}";
  };
  return { rex, blocks, calls };
}

test("a subagent starts detached and is live until its block disappears", async () => {
  const fake = fakeRex();
  const host = rexHost(fake.rex, "s");
  const address = await host.start({ title: "Fix it", cwd: "/tmp", env: {}, command: ["pi"] });
  assert.equal(fake.blocks.get(address)?.placement, "detached");
  assert.equal(await host.isLive(address), true);
  fake.blocks.delete(address);
  assert.equal(await host.isLive(address), false);
});

test("opening a detached subagent places it in its own window without leaving the placeholder", async () => {
  const fake = fakeRex();
  const host = rexHost(fake.rex, "s");
  const address = await host.start({ title: "Fix it", cwd: "/tmp", env: {}, command: ["pi"] });
  await host.open?.(address, "Fix it");
  assert.deepEqual([...fake.blocks.keys()], [address]);
  assert.equal(fake.blocks.get(address)?.placement, "placed");
});

test("opening a subagent that is already in a tab only focuses it", async () => {
  const fake = fakeRex();
  const host = rexHost(fake.rex, "s");
  const address = await host.start({ title: "Fix it", cwd: "/tmp", env: {}, command: ["pi"] });
  await host.open?.(address, "Fix it");
  fake.calls.length = 0;
  await host.open?.(address, "Fix it");
  assert.equal(fake.calls.includes("session.new_window"), false);
});

test("opening a subagent whose block is gone fails", async () => {
  const fake = fakeRex();
  const host = rexHost(fake.rex, "s");
  await assert.rejects(() => host.open?.("missing", "Fix it") ?? Promise.resolve(), /gone/);
});
