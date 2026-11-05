import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTransientSegments } from "../shared/footer-segments.ts";
import type { BackgroundHub } from "./src/hub.ts";
import {
  MAX_ARTIFACT_BYTES,
  removeTerminalArtifactDirectory,
  setupShells,
  settledTerminalIdsToPrune,
  truncateTerminalText,
} from "./shells.ts";

type ToolResult = { content: Array<{ text: string }>; details: { id?: string; status?: string } };
type Tool = { execute: (...args: unknown[]) => Promise<ToolResult> };

function shellTools() {
  const tools = new Map<string, Tool>();
  const pi = {
    on: () => undefined,
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  setupShells(pi, { registerProvider: () => () => undefined } as unknown as BackgroundHub);
  return {
    run: tools.get("background_shell_run")!,
    cancel: tools.get("background_shell_cancel")!,
  };
}

function artifactPath(result: ToolResult | undefined): string | undefined {
  return /Output log: (.+)/.exec(result?.content[0]?.text ?? "")?.[1];
}

test("artifact quota remains 10 MB", () => {
  assert.equal(MAX_ARTIFACT_BYTES, 10 * 1024 * 1024);
});

async function waitForSize(file: string | undefined, size: number) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (file && fs.existsSync(file) && fs.statSync(file).size >= size) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${file} never reached ${size} bytes`);
}

test("run result includes a private output log that receives the full output", async () => {
  const { run } = shellTools();
  const cwd = process.cwd();
  const started = await run.execute(
    "test",
    { command: "head -c 65536 /dev/zero | tr '\\0' x", title: "output", working_dir: cwd },
    undefined,
    undefined,
    { cwd },
  );
  const outputPath = artifactPath(started);
  assert.ok(outputPath);

  await waitForSize(outputPath, 65536);
  assert.equal((await fs.promises.readFile(outputPath)).length, 65536);
  assert.equal((await fs.promises.stat(outputPath)).mode & 0o777, 0o600);
  assert.equal((await fs.promises.stat(path.dirname(outputPath))).mode & 0o777, 0o700);
  await removeTerminalArtifactDirectory(path.dirname(outputPath));
});

test("cancelling waits for buffered artifact output", async () => {
  const { run, cancel } = shellTools();
  const cwd = process.cwd();
  const started = await run.execute(
    "test",
    { command: "head -c 65536 /dev/zero | tr '\\0' x; sleep 5", title: "cancel", working_dir: cwd },
    undefined,
    undefined,
    { cwd },
  );
  const outputPath = artifactPath(started);
  assert.ok(outputPath);

  await waitForSize(outputPath, 65536);
  await cancel.execute("test", { ids: [started.details.id] });
  assert.equal(getTransientSegments().get("terminals"), undefined);
  assert.ok((await fs.promises.readFile(outputPath)).length >= 65536);
  await removeTerminalArtifactDirectory(path.dirname(outputPath));
});

test("terminal text truncation reserves room for its artifact notice", () => {
  const { text, truncated } = truncateTerminalText(
    "line\n".repeat(DEFAULT_MAX_LINES + 1),
    "[Full output: /tmp/output]",
  );

  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text) <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(text, /Full output/);
});

test("settled terminal pruning is oldest-first and never prunes running terminals", () => {
  const ids = settledTerminalIdsToPrune(
    [
      { id: "tr-2", status: "done", startedAt: 1, endedAt: 2 },
      { id: "tr-1", status: "error", startedAt: 1, endedAt: 2 },
      { id: "tr-3", status: "running", startedAt: 0, endedAt: undefined },
      { id: "tr-4", status: "done", startedAt: 1, endedAt: 4 },
    ],
    2,
  );

  assert.deepEqual(ids, ["tr-1", "tr-2"]);
});

test("pruning removes a settled terminal's private artifact directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-terminal-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, "artifact");
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(path.join(artifactDir, "output.log"), "output");

  await removeTerminalArtifactDirectory(artifactDir);

  assert.equal(fs.existsSync(artifactDir), false);
  assert.equal(fs.existsSync(root), true);
});

test("shutdown artifact cleanup is idempotent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-terminal-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactDirs = ["first", "second"].map((name) => path.join(root, name));
  for (const artifactDir of artifactDirs) {
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(path.join(artifactDir, "output.log"), "output");
  }

  await Promise.all(artifactDirs.map(removeTerminalArtifactDirectory));
  await Promise.all(artifactDirs.map(removeTerminalArtifactDirectory));

  assert.deepEqual(fs.readdirSync(root), []);
});
