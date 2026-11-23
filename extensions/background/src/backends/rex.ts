/**
 * Rex terminal host. A subagent's pi runs in a detached block of the parent's
 * session: it runs and reports over the channel, but no tab shows it, so Rex
 * raises no activity or notifications for it. `open` places the block in its
 * own tab; the `send_back` action in rex/init.lua detaches it again.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import type { TerminalHost } from "./hc.ts";

const REX_TIMEOUT_MS = 15_000;
const SHELL = "com.superlogical.terminal.shell";

/** Block labels start with this so `send_back` detaches only subagents. Keep in sync with rex/init.lua. */
export const SUBAGENT_LABEL_PREFIX = "sub: ";

/** Runs `rex` with arguments and resolves with its stdout. */
export type RexRunner = (args: ReadonlyArray<string>) => Promise<string>;

export const execRex: RexRunner = (args) =>
  new Promise((resolve, reject) => {
    const bin = process.env.REX_BIN_DIR ? path.join(process.env.REX_BIN_DIR, "rex") : "rex";
    execFile(bin, [...args], { timeout: REX_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      reject(new Error(`rex ${args[0]}: ${stderr.trim() || error.message}`));
    });
  });

interface BlockInfo {
  readonly block_id: string;
  readonly placement: string;
  readonly window_id?: string;
}

export function rexHost(rex: RexRunner, sessionId: string): TerminalHost {
  const call = async <T>(method: string, args: Readonly<Record<string, unknown>>) =>
    JSON.parse(await rex(["api", "call", "-s", sessionId, method, JSON.stringify(args)])) as T;

  const findBlock = async (address: string) =>
    (await call<{ blocks?: ReadonlyArray<BlockInfo> | null }>("session.list_blocks", {})).blocks?.find(
      (block) => block.block_id === address,
    );

  const appClients = () =>
    call<{ clients?: ReadonlyArray<{ client_id: string; info: { kind: string } }> }>("session.list_clients", {}).then(
      (listed) => (listed.clients ?? []).filter((client) => client.info.kind === "app"),
      () => [],
    );

  // Rex.app follows only its own selection. Needs Remote Control on in Rex's settings, so it is best effort.
  const showWindow = (clients: ReadonlyArray<{ client_id: string }>, windowId: string | undefined) =>
    Promise.all(
      clients.map((client) =>
        rex([
          "-C",
          client.client_id,
          "do",
          "session.select",
          `session_id=${sessionId}`,
          ...(windowId ? [`window_id=${windowId}`] : []),
        ]).catch(() => undefined),
      ),
    );

  return {
    start: async ({ title, cwd, env, command }) => {
      // The user may open the child in a tab; its own status reports would then notify like the parent's.
      const childEnv = Object.entries({ ...env, PI_PROGRAM_STATUS: "0" }).map(([key, value]) => `${key}=${value}`);
      const { block_id } = await call<{ block_id?: string }>("session.new_block", {
        flavor: SHELL,
        label: `${SUBAGENT_LABEL_PREFIX}${title}`.slice(0, 128),
        options: { cwd, command: ["env", ...childEnv, ...command] },
      });
      if (!block_id) throw new Error("rex new_block returned no block_id");
      return block_id;
    },
    // A detached block disappears when its program exits.
    isLive: async (address) => {
      try {
        return (await findBlock(address)) !== undefined;
      } catch {
        return false;
      }
    },
    stop: async (address) => {
      await rex(["block", "close", "-s", sessionId, address]).catch(() => undefined);
    },
    open: async (address, title) => {
      const clients = appClients();
      const block = await findBlock(address);
      if (!block) throw new Error("The subagent's terminal is gone.");
      let windowId = block.window_id;
      let placeholder: string | undefined;
      if (block.placement === "detached") {
        // A window needs a block of its own, so the child joins a placeholder's window and the placeholder closes.
        const window = await call<{ window_id?: string; block_ids?: ReadonlyArray<string> }>("session.new_window", {
          window_label: title.slice(0, 128),
          layout: { block: { flavor: SHELL, label: "opening" } },
        });
        placeholder = window.block_ids?.[0];
        if (!placeholder) throw new Error("rex new_window returned no block");
        await call("session.move_block", { block_id: address, anchor_block_id: placeholder });
        windowId = window.window_id;
      }
      await Promise.all([call("session.focus_block", { block_id: address }), showWindow(await clients, windowId)]);
      if (placeholder) await rex(["block", "close", "-s", sessionId, placeholder]);
    },
  };
}

/** Subagents run in Rex blocks when the parent runs in a Rex terminal. */
export function rexBackendAvailable() {
  return Boolean(process.env.REX_SESSION && process.env.REX_BLOCK);
}
