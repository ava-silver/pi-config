import assert from "node:assert/strict";
import test from "node:test";
import { hasLiveSubagentOwner, restorableSubagents } from "./subagents.ts";
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

test("removed subagents are not restored, but their ids stay reserved", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: "background-subagent-state", data });
  const removal = entry({ version: 1, id: "sa-1", removed: true });
  const removed = restorableSubagents([entry(record("done", 1)), removal]);
  assert.deepEqual([...removed.records.keys()], []);
  assert.equal(removed.highestId, 1);
  const readded = restorableSubagents([entry(record("done", 1)), removal, entry(record("done", 1))]);
  assert.deepEqual([...readded.records.keys()], ["sa-1"]);
});
