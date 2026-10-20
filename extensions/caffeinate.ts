import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface InhibitorCommand {
  command: string;
  args: string[];
}

/**
 * Returns a command that keeps the display awake until it is killed or `pid` exits,
 * or `undefined` when the platform has no supported inhibitor.
 */
export function inhibitorCommand(platform: NodeJS.Platform, pid: number): InhibitorCommand | undefined {
  switch (platform) {
    case "darwin":
      return { command: "caffeinate", args: ["-d", "-w", String(pid)] };
    case "linux":
      // systemd-inhibit execs its command, so killing it releases the lock. `tail --pid` exits when
      // Pi dies, which prevents an orphaned lock after a crash.
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle",
          "--who=pi",
          "--why=Pi agent is running",
          "--mode=block",
          "tail",
          `--pid=${pid}`,
          "-f",
          "/dev/null",
        ],
      };
    default:
      return undefined;
  }
}

export default function caffeinateExtension(pi: ExtensionAPI): void {
  let inhibitor: ChildProcess | undefined;
  let unavailable = false;

  const start = (): void => {
    if (inhibitor || unavailable) return;
    const spec = inhibitorCommand(process.platform, process.pid);
    if (!spec) {
      unavailable = true;
      return;
    }
    const child = spawn(spec.command, spec.args, { stdio: "ignore" });
    inhibitor = child;
    child.once("error", () => {
      // The inhibitor binary is missing; keeping the display awake is best-effort.
      unavailable = true;
      if (inhibitor === child) inhibitor = undefined;
    });
    child.once("exit", () => {
      if (inhibitor === child) inhibitor = undefined;
    });
  };

  const stop = (): void => {
    inhibitor?.kill();
    inhibitor = undefined;
  };

  pi.on("agent_start", start);
  pi.on("agent_settled", stop);
  pi.on("session_shutdown", stop);
}
