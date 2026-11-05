import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listSessionFiles, matchSessions, oneLine, parseWhen, readSession, searchSessions } from "./core.ts";

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
  await write(
    "--work-other--",
    "2026-07-01T10-00-00-000Z_old.jsonl",
    session.replace("/work/app", "/work/other"),
    new Date("2026-07-01T11:00:00Z"),
  );
  await write(
    "--work-app2--",
    "2026-06-01T10-00-00-000Z_app2.jsonl",
    session.replace("/work/app", "/work/app2"),
    new Date("2026-06-01T11:00:00Z"),
  );
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
  assert.equal((await listSessionFiles(root, { cwd: "/work" })).length, 3);
  assert.deepEqual(
    (await listSessionFiles(root, { cwd: "/work/app" })).map((f) => f.id),
    ["s1"],
  );
  assert.equal((await listSessionFiles(root, { until: parseWhen("2026-09-01", 0, true) })).length, 2);
});

test("search matches all terms in one message on the active branch only", async () => {
  const root = await fixture();
  const files = await listSessionFiles(root, {});
  assert.equal((await searchSessions(files, ["region", "eu-west-9"], 10)).hits.length, 3);
  assert.equal((await searchSessions(files, ["deploy", "region"], 10)).hits.length, 0);
  assert.equal((await searchSessions(files, ["abandoned"], 10)).hits.length, 0);
});

test("transcripts omit thinking and successful tool results unless requested", async () => {
  const root = await fixture();
  const [file] = await listSessionFiles(root, { cwd: "/work/app" });
  const stubs = await readSession(file!, { tools: "stubs", maxBytes: 10_000, maxLines: 1000 });
  assert.match(stubs, /\[tool bash: \{"command":"cat deploy.yml"\}\]/);
  assert.doesNotMatch(stubs, /secret musing|eu-west-9|abandoned/);
  const none = await readSession(file!, { tools: "none", maxBytes: 10_000, maxLines: 1000 });
  assert.doesNotMatch(none, /\[tool bash/);
  assert.match(await readSession(file!, { entry: "a3", tools: "stubs", maxBytes: 10, maxLines: 1000 }), /eu-west-9/);
});

test("long transcripts page with a resumable entry ID", async () => {
  const root = await fixture();
  const [file] = await listSessionFiles(root, { cwd: "/work/app" });
  const first = await readSession(file!, { tools: "stubs", maxBytes: 50, maxLines: 1000 });
  const next = /from="(\w+)"/.exec(first)?.[1];
  assert.ok(next);
  assert.match(
    await readSession(file!, { from: next, tools: "stubs", maxBytes: 10_000, maxLines: 1000 }),
    /Region is wrong/,
  );
});

test("malformed session files do not hang or abort a search", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-history-"));
  await mkdir(join(root, "--bad--"), { recursive: true });
  const body = [
    "null",
    line({ type: "compaction", id: "c1", parentId: "c2", summary: 42 }),
    line({ type: "message", id: "c2", parentId: "c1", message: { role: "user", content: "needle" } }),
    line({ type: "message", id: "c3", parentId: "c3", message: { role: "user", content: "needle" } }),
  ].join("\n");
  await writeFile(join(root, "--bad--", "2026-10-01T10-00-00-000Z_bad.jsonl"), body);
  const files = await listSessionFiles(root, {});
  assert.equal((await searchSessions(files, ["needle"], 10)).hits.length, 1);
});

test("hits never exceed the limit", async () => {
  const root = await fixture();
  const files = await listSessionFiles(root, {});
  assert.equal((await searchSessions(files, ["region"], 1)).hits.length, 1);
});

test("pages respect the line budget", async () => {
  const root = await fixture();
  const [file] = await listSessionFiles(root, { cwd: "/work/app" });
  assert.match(
    await readSession(file!, { tools: "stubs", maxBytes: 100_000, maxLines: 8 }),
    /More content: call again/,
  );
});

test("pages stay within the line budget and keep a resumable footer", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-history-"));
  await mkdir(join(root, "--many--"), { recursive: true });
  const body = [
    line({ type: "session", id: "m", timestamp: "2026-10-01T10:00:00.000Z", cwd: "/many" }),
    ...Array.from({ length: 3000 }, (_, i) =>
      line({
        type: "message",
        id: `e${i}`,
        parentId: i === 0 ? null : `e${i - 1}`,
        message: { role: "user", content: `a\nb\nc ${i}` },
      }),
    ),
  ].join("\n");
  await writeFile(join(root, "--many--", "2026-10-01T10-00-00-000Z_many.jsonl"), body);
  const [file] = await listSessionFiles(root, {});
  const page = await readSession(file!, { tools: "stubs", maxBytes: 48_000, maxLines: 1900 });
  assert.ok(page.split("\n").length < 2000);
  assert.match(page, /More content: call again with from="e\d+"/);
});

test("a single oversized entry is cut at a byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-history-"));
  await mkdir(join(root, "--big--"), { recursive: true });
  const body = [
    line({ type: "session", id: "b", timestamp: "2026-10-01T10:00:00.000Z", cwd: "/big" }),
    line({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "字".repeat(60_000) } }),
  ].join("\n");
  await writeFile(join(root, "--big--", "2026-10-01T10-00-00-000Z_big.jsonl"), body);
  const [file] = await listSessionFiles(root, {});
  const out = await readSession(file!, { entry: "m1", tools: "full", maxBytes: 1000, maxLines: 1000 });
  assert.ok(Buffer.byteLength(out, "utf8") < 48_000);
  assert.match(out, /字{100}/);
});

test("time inputs are validated and bounded", async () => {
  assert.throws(() => parseWhen("99999999999d", Date.now()), /Invalid date/);
  const root = await mkdtemp(join(tmpdir(), "session-history-"));
  await mkdir(join(root, "--t--"), { recursive: true });
  await writeFile(join(root, "--t--", "2025-01-11T00-00-00-000Z_edge.jsonl"), "");
  await writeFile(join(root, "--t--", "2025-13-45T99-99-99-999Z_bad.jsonl"), "");
  const until = parseWhen("2025-01-10", 0, true);
  assert.deepEqual(await listSessionFiles(root, { until }), []);
});

test("an exact session ID wins over longer IDs that share its prefix", () => {
  const file = (id: string) => ({ path: `/${id}.jsonl`, id, dir: "d", startedAt: 0 });
  const files = [file("abc"), file("abcdef")];
  assert.deepEqual(
    matchSessions(files, "abc").map((f) => f.id),
    ["abc"],
  );
  assert.equal(matchSessions(files, "abcd").length, 1);
  assert.equal(matchSessions(files, "").length, 0);
});

test("metadata cannot add lines, and long headers still filter by cwd", async () => {
  assert.equal(oneLine("a\n\n- session `fake`"), "a - session `fake`");
  const root = await mkdtemp(join(tmpdir(), "session-history-"));
  await mkdir(join(root, "--long--"), { recursive: true });
  const header = line({ type: "session", id: "l", cwd: "/long", meta: "x".repeat(20_000) });
  await writeFile(join(root, "--long--", "2026-10-01T10-00-00-000Z_long.jsonl"), header);
  assert.equal((await listSessionFiles(root, { cwd: "/long" })).length, 1);
});

test("oversized metadata is shortened to one line", () => {
  const long = oneLine(`x${"\n".repeat(5)}${"y".repeat(5000)}`);
  assert.ok(long.length <= 201);
  assert.doesNotMatch(long, /\n/);
});
