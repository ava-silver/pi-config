import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Write a private HTML report and open it in the default browser. Returns whether the browser opened. */
export async function openReport(pi: ExtensionAPI, file: string, html: string): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html, { mode: 0o600 });
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
  const result = await pi.exec(command, args, { timeout: 5_000 });
  return result.code === 0;
}
