import assert from "node:assert/strict";
import test from "node:test";
import { hasLiveSubagentOwner } from "./subagents.ts";
import type { PersistedSubagent } from "./src/domain.ts";

function record(status: PersistedSubagent["status"], ownerPid: number): PersistedSubagent {
  return {
    version: 1,
    ownerPid,
    id: "sa-1",
    title: "test",
    prompt: "test",
    cwd: process.cwd(),
    status,
    createdAt: Date.now(),
    finalText: "",
    meta: { sessionFilePath: "/tmp/subagent.jsonl" },
  };
}

test("a running subagent owned by a live process starts a fresh session", () => {
  assert.equal(hasLiveSubagentOwner([record("running", process.pid)]), true);
  assert.equal(hasLiveSubagentOwner([record("done", process.pid)]), false);
});
