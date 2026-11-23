/**
 * Layer composition and the async entry-point boundary.
 *
 * Everything inside the extension is Effect generators; this module is where
 * tool handlers (plain async functions) run those effects against one shared
 * ManagedRuntime.
 */

import { Cause, Exit, ManagedRuntime, type Effect } from "effect";
import { hcBackendAvailable } from "./backends/hc.ts";
import { rexBackendAvailable } from "./backends/rex.ts";
import { SubagentManagerHc, SubagentManagerLive, SubagentManagerRex } from "./manager.ts";

/** Subagents are interactive pi terminals when the parent runs in Herdr or Rex. */
export const terminalBackendAvailable = () => hcBackendAvailable() || rexBackendAvailable();

export function createSubagentRuntime() {
  return ManagedRuntime.make(
    hcBackendAvailable() ? SubagentManagerHc : rexBackendAvailable() ? SubagentManagerRex : SubagentManagerLive,
  );
}

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

/**
 * Run an effect from an async tool handler. Typed failures and defects are
 * converted to thrown Errors (what pi's tool contract expects); interruption
 * (tool AbortSignal) throws `interruptMessage`.
 */
export async function runTool<A, E>(
  runtime: SubagentRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
  const exit = await runtime.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined);
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "Operation was aborted.");
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
