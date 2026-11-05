import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSessionFiles, parseWhen, readSession, searchSessions } from "./core.ts";

const line = (value: unknown) => JSON.stringify(value);
const session = [
  line({ type: "session", id: "s1", timestamp: "2026-10-01T10:00:00.000Z", cwd: "/work/app" }),
  line({
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: "2026-10-01T10:00:01.000Z",
    message: { role: "user", content: "Why does deploy fail?" },
  }),
  line({
    type: "message",
    id: "a2",
    parentId: "a1",
    timestamp: "2026-10-01T10:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret musing" },
        { type: "text", text: "Checking the config." },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "cat deploy.yml" } },
      ],
    },
  }),
  line({
    type: "message",
    id: "a3",
    parentId: "a2",
    timestamp: "2026-10-01T10:00:03.000Z",
    message: {
      role: "toolResult",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "region: eu-west-9" }],
    },
  }),
  line({
    type: "message",
    id: "dead",
    parentId: "a1",
    timestamp: "2026-10-01T10:00:04.000Z",
    message: { role: "user", content: "abandoned branch" },
  }),
  line({
    type: "message",
    id: "a4",
    parentId: "a3",
    timestamp: "2026-10-01T10:00:05.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Region is wrong." }] },
  }),
].join("\n");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "session-history-"));
  const write = async (dir: string, name: string, body: string, mtime: Date) => {
    await mkdir(join(root, dir), { recursive: true });
    const path = join(root, dir, name);
    await writeFile(path, body);
    await utimes(path, mtime, mtime);
  };
  await write("--work-app--", "2026-10-01T10-00-00-000Z_s1.jsonl", session, new Date("2026-10-01T11:00:00Z"));
  await write("--work-other--", "2026-07-01T10-00-00-000Z_old.jsonl", session, new Date("2026-07-01T11:00:00Z"));
  return root;
}

test("listing filters by directory subtree and by recent activity", async () => {
  const root = await fixture();
  const since = parseWhen("2026-09-01", 0);
  assert.deepEqual(
    (await listSessionFiles(root, { since })).map((f) => f.id),
    ["s1"],
  );
  assert.deepEqual(
    (await listSessionFiles(root, { cwd: "/work/other" })).map((f) => f.id),
    ["old"],
  );
  assert.equal((await listSessionFiles(root, { cwd: "/work" })).length, 2);
  assert.equal((await listSessionFiles(root, { until: parseWhen("2026-09-01", 0, true) })).length, 1);
});

test("search matches all terms in one message on the active branch only", async () => {
  const root = await fixture();
  const files = await listSessionFiles(root, {});
  assert.equal((await searchSessions(files, ["region", "eu-west-9"], 10)).hits.length, 2);
  assert.equal((await searchSessions(files, ["deploy", "region"], 10)).hits.length, 0);
  assert.equal((await searchSessions(files, ["abandoned"], 10)).hits.length, 0);
});

test("transcripts omit thinking and successful tool results unless requested", async () => {
  const root = await fixture();
  const [file] = await listSessionFiles(root, { cwd: "/work/app" });
  const stubs = await readSession(file!, { tools: "stubs", maxChars: 10_000 });
  assert.match(stubs, /\[tool bash: \{"command":"cat deploy.yml"\}\]/);
  assert.doesNotMatch(stubs, /secret musing|eu-west-9|abandoned/);
  const none = await readSession(file!, { tools: "none", maxChars: 10_000 });
  assert.doesNotMatch(none, /\[tool bash/);
  assert.match(await readSession(file!, { entry: "a3", tools: "stubs", maxChars: 10 }), /eu-west-9/);
});

test("long transcripts page with a resumable entry ID", async () => {
  const root = await fixture();
  const [file] = await listSessionFiles(root, { cwd: "/work/app" });
  const first = await readSession(file!, { tools: "stubs", maxChars: 50 });
  const next = /from="(\w+)"/.exec(first)?.[1];
  assert.ok(next);
  assert.match(await readSession(file!, { from: next, tools: "stubs", maxChars: 10_000 }), /Region is wrong/);
});
