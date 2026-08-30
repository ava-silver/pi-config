import { FileFinder, type GrepMode } from "@ff-labs/fff-bun";

type Request = {
  id: number;
  cwd: string;
  kind: "find" | "grep";
  query: string;
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

async function search({ cwd, kind, query, limit, context, mode, timeoutMs }: Request) {
  const activeFinder = await getFinder(cwd);
  if (kind === "find") {
    const result = activeFinder.fileSearch(query, { pageSize: limit });
    if (!result.ok) throw new Error(result.error);
    return {
      items: result.value.items.map((item) => item.relativePath),
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
    totalMatched: result.value.totalMatched,
    totalFiles: result.value.totalFiles,
  };
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
