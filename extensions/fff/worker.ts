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
  if (mode === "regex") await validateRegex(pattern ?? query, cwd);
  if (kind === "external-find") return searchFilesWithRg(externalPath(query, cwd), pattern ?? "", limit, cwd);
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

function validateRegex(pattern: string, cwd: string): Promise<string> {
  return rg(["--engine", "default", "--regexp", pattern, process.platform === "win32" ? "NUL" : "/dev/null"], cwd);
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

function matchesFilename(path: string, pattern: string): boolean {
  const lowercasePath = path.toLowerCase();
  return pattern
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => lowercasePath.includes(term));
}

async function searchFilesWithRg(path: string, pattern: string, limit: number, cwd: string) {
  const output = await rg(["--files", path], cwd);
  const matches = (output ? output.split("\n") : []).filter((item) => matchesFilename(item, pattern));
  const items = matches.slice(0, limit);
  return { items, resultCount: items.length, totalMatched: matches.length, totalFiles: matches.length };
}

function grepArgs(pattern: string, mode: GrepMode): string[] {
  return [...(mode === "plain" ? ["--fixed-strings"] : []), "--", pattern];
}

function matchCount(output: string): number {
  return output.split("\n").filter((line) => /^(?:\d+:|.*:\d+:)/.test(line)).length;
}

function totalMatchCount(output: string): number {
  return output
    .split("\n")
    .filter(Boolean)
    .reduce((total, line) => total + Number(line), 0);
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
  const files = await rg(["--files-with-matches", ...grepArgs(pattern, mode), path], cwd);
  const matchingFiles = files.split("\n").filter(Boolean);
  const totalMatched = totalMatchCount(
    await rg(["--count-matches", "--no-filename", ...grepArgs(pattern, mode), path], cwd),
  );
  let resultCount = 0;
  const output: string[] = [];
  for (const file of matchingFiles) {
    if (resultCount >= limit) break;
    const matches = await rg(
      [
        "--line-number",
        "--no-heading",
        "--with-filename",
        "--color=never",
        "--max-count",
        String(limit - resultCount),
        ...(context > 0 ? ["--context", String(context)] : []),
        ...grepArgs(pattern, mode),
        file,
      ],
      cwd,
    );
    resultCount += matchCount(matches);
    if (matches) output.push(matches);
  }
  return { items: [], output: output.join("\n"), resultCount, totalMatched, totalFiles: matchingFiles.length };
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
