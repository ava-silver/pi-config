import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const SAMPLE_INTERVAL_MS = 100;
const DEFAULT_THRESHOLD_MS = 1_000;
const LOG_FILE = "ui-blocking.jsonl";

function thresholdMs(): number {
  const value = Number(process.env.PI_UI_BLOCKING_THRESHOLD_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_THRESHOLD_MS;
}

export default function uiPerformanceExtension(pi: ExtensionAPI): void {
  const logPath = join(getAgentDir(), LOG_FILE);
  const threshold = thresholdMs();
  const extensionLoadedAt = performance.now();
  let lastSample = extensionLoadedAt;
  let writes: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sessionStartedAt: number | undefined;

  const record = (data: { delayMs?: number; phase: string; waitMs?: number }): void => {
    const entry = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...data,
      ...(data.delayMs === undefined ? {} : { delayMs: Math.round(data.delayMs) }),
      thresholdMs: threshold,
      cwd: process.cwd(),
    })}\n`;
    writes = writes.then(() => appendFile(logPath, entry)).catch(() => {});
  };

  const start = (): void => {
    if (timer) return;
    lastSample = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      const delay = now - lastSample - SAMPLE_INTERVAL_MS;
      lastSample = now;
      if (delay >= threshold) record({ phase: "event-loop", delayMs: delay });
    }, SAMPLE_INTERVAL_MS);
    timer.unref();
  };

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  // This catches synchronous event-loop stalls during startup and normal use.
  // The log is intentionally JSONL so it can be searched and aggregated later.
  start();
  pi.on("session_start", () => {
    sessionStartedAt = performance.now();
    record({ phase: "session-start", waitMs: sessionStartedAt - extensionLoadedAt });
    setImmediate(() => {
      if (sessionStartedAt === undefined) return;
      record({ phase: "startup-ready", waitMs: performance.now() - sessionStartedAt });
    });
  });
  pi.on("session_shutdown", (_event, _ctx: ExtensionContext) => stop());
}
