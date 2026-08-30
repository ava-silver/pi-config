import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { FileFinder, type GrepMode } from "@ff-labs/fff-bun";

type Request = {
  id: number;
  cwd: string;
  kind: "find" | "grep" | "external-find" | "external-grep";
  query: string;
  pattern?: string;
  limit: number;
  context?: number;
  mode?: GrepMode;
  timeoutMs?: number;
};

let finder: FileFinder | undefined;
let finderCwd: string | undefined;

async function getFinder(cwd: string): Promise<FileFinder> {
  if (finder && finderCwd === cwd && !finder.isDestroyed) return finder;
  finder?.destroy();
  const created = FileFinder.create({
    basePath: cwd,
    aiMode: true,
    disableWatch: true,
    followSymlinks: false,
  });
  if (!created.ok) throw new Error(created.error);
  finder = created.value;
  finderCwd = cwd;
  await finder.waitForScan(15_000);
  return finder;
}

function respond(id: number, result: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, ...result })}\n`);
}

function externalPath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(cwd, path);
}

async function search({ cwd, kind, query, pattern, limit, context, mode, timeoutMs }: Request) {
  if (kind === "external-find") return searchFilesWithRg(externalPath(query, cwd), limit, cwd);
  if (kind === "external-grep") {
    return searchContentsWithRg({
      pattern: pattern ?? "",
      path: externalPath(query, cwd),
      limit,
      context: context ?? 0,
      mode: mode ?? "plain",
      cwd,
    });
  }

  const activeFinder = await getFinder(cwd);
  if (kind === "find") {
    const result = activeFinder.fileSearch(query, { pageSize: limit });
    if (!result.ok) throw new Error(result.error);
    return {
      items: result.value.items.map((item) => item.relativePath),
      resultCount: result.value.items.length,
      totalMatched: result.value.totalMatched,
      totalFiles: result.value.totalFiles,
    };
  }

  const result = activeFinder.grep(query, {
    mode: mode ?? "plain",
    smartCase: true,
    pageSize: limit,
    maxMatchesPerFile: limit,
    beforeContext: context ?? 0,
    afterContext: context ?? 0,
    timeBudgetMs: timeoutMs ?? 30_000,
  });
  if (!result.ok) throw new Error(result.error);
  return {
    items: result.value.items,
    resultCount: result.value.items.length,
    totalMatched: result.value.totalMatched,
    totalFiles: result.value.totalFiles,
  };
}

function rg(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== null && code > 1) reject(new Error(stderr.trim() || "rg failed"));
      else resolve(stdout.trim());
    });
  });
}

async function searchFilesWithRg(path: string, limit: number, cwd: string) {
  const output = await rg(["--files", path], cwd);
  const items = output ? output.split("\n").slice(0, limit) : [];
  return { items, resultCount: items.length, totalMatched: items.length, totalFiles: items.length };
}

async function searchContentsWithRg({
  pattern,
  path,
  limit,
  context,
  mode,
  cwd,
}: {
  pattern: string;
  path: string;
  limit: number;
  context: number;
  mode: GrepMode;
  cwd: string;
}) {
  const output = await rg(
    [
      "--line-number",
      "--no-heading",
      "--color=never",
      "--max-count",
      String(limit),
      ...(context > 0 ? ["--context", String(context)] : []),
      ...(mode === "plain" ? ["--fixed-strings"] : []),
      "--",
      pattern,
      path,
    ],
    cwd,
  );
  const resultCount = output.split("\n").filter((line) => /^(?:\d+:|.*:\d+:)/.test(line)).length;
  return { items: [], output, resultCount, totalMatched: resultCount, totalFiles: resultCount };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    const request = JSON.parse(line) as Request;
    void search(request)
      .then((result) => respond(request.id, { ok: true, result }))
      .catch((error) => respond(request.id, { ok: false, error: String(error) }));
  }
});

process.on("exit", () => finder?.destroy());
