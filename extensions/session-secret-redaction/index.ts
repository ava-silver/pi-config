import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTransientSegment } from "../shared/footer-segments.ts";

type Finding = {
  line: number;
  column_start: number;
  column_end: number;
  snippet: string | undefined;
};

type SarifOutput = {
  runs?: Array<{
    results?: Array<{
      locations?: Array<{
        physicalLocation?: {
          region?: {
            startLine?: number;
            startColumn?: number;
            endLine?: number;
            endColumn?: number;
            snippet?: { text?: string };
          };
        };
      }>;
    }>;
  }>;
};

type ParsedScan = {
  findings: Finding[];
  reportedCount: number;
};

const MAX_CONCURRENT_SCANS = Math.min(8, availableParallelism());

function parseFindings(output: string): ParsedScan {
  const sarif = JSON.parse(output) as SarifOutput;
  if (!sarif.runs) throw new Error("Kingfisher returned SARIF without runs.");
  const results = sarif.runs.flatMap((run) => run.results ?? []);
  const findings = results.flatMap((result) =>
    (result.locations ?? []).flatMap((location) => {
      const region = location.physicalLocation?.region;
      if (!region?.startLine || !region.startColumn) return [];
      return [
        {
          line: region.startLine,
          column_start: region.startColumn - 1,
          column_end: (region.endColumn ?? region.startColumn) - 2,
          snippet: region.snippet?.text,
        },
      ];
    }),
  );
  return { findings, reportedCount: results.length };
}

function redact(content: string, findings: Finding[]): string {
  const lines = content.split("\n");
  const byLine = new Map<number, Finding[]>();

  for (const finding of findings) {
    const matches = byLine.get(finding.line) ?? [];
    matches.push(finding);
    byLine.set(finding.line, matches);
  }

  for (const [lineNumber, matches] of byLine) {
    const line = Array.from(lines[lineNumber - 1] ?? "");
    for (const finding of matches.sort((a, b) => b.column_start - a.column_start)) {
      const matchedSnippet = finding.snippet;
      const snippetStart = matchedSnippet ? line.join("").indexOf(matchedSnippet) : -1;
      const start = snippetStart >= 0 ? snippetStart : finding.column_start;
      const end = snippetStart >= 0 ? start + Array.from(matchedSnippet ?? "").length : finding.column_end + 1;
      if (start < 0 || end > line.length || start >= end) {
        throw new Error(`Invalid Kingfisher range at ${lineNumber}:${finding.column_start}-${finding.column_end}`);
      }
      line.splice(start, end - start, ...Array<string>(end - start).fill("*"));
    }
    lines[lineNumber - 1] = line.join("");
  }

  const redacted = lines.join("\n");
  for (const line of redacted.split("\n")) {
    if (line) JSON.parse(line);
  }
  return redacted;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  maxConcurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await map(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, worker));
  return results;
}

async function ensureKingfisher(pi: ExtensionAPI): Promise<void> {
  try {
    const result = await pi.exec("kingfisher", ["--version"], { timeout: 10_000 });
    if (result.code === 0) return;
  } catch {
    // Report the missing provisioned dependency below.
  }

  throw new Error("Kingfisher is not installed.");
}

async function redactFile(pi: ExtensionAPI, sessionFile: string): Promise<number> {
  try {
    await stat(sessionFile);
  } catch {
    return 0;
  }

  const result = await pi.exec(
    "kingfisher",
    [
      "scan",
      sessionFile,
      "--rules-path",
      `${import.meta.dirname}/rules.yaml`,
      "--git-history",
      "none",
      "--validation-filter",
      "actionable",
      "--no-dedup",
      "--format",
      "sarif",
      "--no-update-check",
    ],
    { timeout: 60_000 },
  );
  if (![0, 200, 205].includes(result.code))
    throw new Error(`Kingfisher scan failed: (${result.code}) - ${result.stdout.trim()}${result.stderr.trim()}`);

  const { findings, reportedCount } = parseFindings(result.stdout);
  if (reportedCount > 0 && findings.length === 0) {
    throw new Error(`Kingfisher reported ${reportedCount} finding(s), but returned no redactable locations.`);
  }
  if (findings.length === 0) return 0;

  const info = await stat(sessionFile);
  const content = await readFile(sessionFile, "utf8");
  const redacted = redact(content, findings);
  const temporary = `${sessionFile}.redact-${process.pid}.tmp`;
  try {
    await writeFile(temporary, redacted, { mode: info.mode });
    await rename(temporary, sessionFile);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return findings.length;
}

async function redactSession(pi: ExtensionAPI, ctx: ExtensionContext): Promise<number> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return 0;
  await ensureKingfisher(pi);
  return redactFile(pi, sessionFile);
}

export default function sessionSecretRedaction(pi: ExtensionAPI): void {
  let pending = Promise.resolve();

  function setStatus(ctx: ExtensionContext, text?: string): void {
    if (ctx.mode !== "tui") return;
    registerTransientSegment("session-secret-redaction", text ? { text, bg: "#414559", fg: "#838ba7" } : null);
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = pending.then(task);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function run(ctx: ExtensionContext): Promise<void> {
    return enqueue(async () => {
      try {
        const count = await redactSession(pi, ctx);
        if (count > 0 && ctx.hasUI) {
          ctx.ui.notify(`Redacted ${count} secret${count === 1 ? "" : "s"} from this session.`, "info");
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        console.error(`[session-secret-redaction] ${reason}`, error);
        if (ctx.hasUI) {
          ctx.ui.notify(`Could not redact secrets from this Pi session: ${reason}`, "warning");
        }
      }
    });
  }

  pi.registerCommand("redact-secrets", {
    description: "Redact secrets from all saved sessions",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      setStatus(ctx, "redacting secrets...");

      try {
        const result = await enqueue(async () => {
          await ensureKingfisher(pi);
          const sessions = await SessionManager.listAll();
          let completedCount = 0;
          setStatus(ctx, `redacting secrets 0/${sessions.length}...`);
          const results = await mapWithConcurrency(sessions, MAX_CONCURRENT_SCANS, async (session) => {
            try {
              return { redactedCount: await redactFile(pi, session.path), failed: false };
            } catch (error) {
              console.error(`[session-secret-redaction] Could not redact ${session.path}`, error);
              return { redactedCount: 0, failed: true };
            } finally {
              completedCount += 1;
              setStatus(ctx, `redacting secrets ${completedCount}/${sessions.length}...`);
            }
          });
          const { redactedCount, failedCount } = results.reduce(
            (total, result) => ({
              redactedCount: total.redactedCount + result.redactedCount,
              failedCount: total.failedCount + Number(result.failed),
            }),
            { redactedCount: 0, failedCount: 0 },
          );
          return { redactedCount, failedCount, sessionCount: sessions.length };
        });

        if (ctx.hasUI) {
          const message = result.redactedCount
            ? `Redacted ${result.redactedCount} secret${result.redactedCount === 1 ? "" : "s"} from ${result.sessionCount} session${result.sessionCount === 1 ? "" : "s"}.`
            : `No secrets found in ${result.sessionCount} session${result.sessionCount === 1 ? "" : "s"}.`;
          ctx.ui.notify(
            result.failedCount
              ? `${message} ${result.failedCount} session${result.failedCount === 1 ? " could not be scanned" : "s could not be scanned"}.`
              : message,
            result.failedCount ? "warning" : "info",
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        console.error(`[session-secret-redaction] ${reason}`, error);
        if (ctx.hasUI) ctx.ui.notify(`Could not redact secrets: ${reason}`, "warning");
      } finally {
        setStatus(ctx);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Scanning can take up to 70 seconds. It must not delay the interactive prompt.
    if (ctx.mode === "tui") {
      void run(ctx);
      return;
    }
    return run(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => run(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    setStatus(ctx);
    return run(ctx);
  });
}
