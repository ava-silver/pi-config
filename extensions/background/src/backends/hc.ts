/**
 * Terminal backend: each subagent is an interactive pi in its own terminal,
 * hosted by herdr-core (`hc`, below) or Rex (./rex.ts). The child reports over
 * a file channel (see ../channel.ts and ../child.ts); the host only starts,
 * checks, and stops the terminal.
 *
 * - spawn writes the prompt to the inbox, then starts the terminal;
 * - send/answer/interrupt/compact append commands to the inbox;
 * - a send or compact after the child's pi exited (or after restore) starts
 *   a new terminal on the same session file;
 * - closing the scope kills and removes the terminal.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import { resolveChildModel } from "../../../shared/child-session.ts";
import { sessionCost } from "../../../shared/session-cost.ts";
import {
  appendLine,
  CHANNEL_ENV,
  channelPaths,
  type CompactionReply,
  isCompactionReply,
  isSubagentEvent,
  type ParentCommand,
  tailJsonl,
} from "../channel.ts";
import type { CompactionOutcome, SpawnTask, SubagentEvent, SubagentMeta, SubagentSession } from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { boundedError, replayTranscript } from "./pi-events.ts";

const HC_TIMEOUT_MS = 15_000;
const LIVENESS_MS = 3_000;
const INTERRUPT_WAIT_MS = 4_000;
const COMPACT_TIMEOUT_MS = 10 * 60_000;

/** Runs `hc` with arguments and resolves with its stdout. */
export type HcRunner = (args: ReadonlyArray<string>) => Promise<string>;

/** What a terminal needs to start: a program with extra environment, in a directory. */
export interface TerminalSpec {
  readonly title: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly command: ReadonlyArray<string>;
}

/** Where subagent terminals live. An address names one terminal for its lifetime. */
export interface TerminalHost {
  start(spec: TerminalSpec): Promise<string>;
  isLive(address: string): Promise<boolean>;
  /** Ends the terminal and removes it. */
  stop(address: string): Promise<void>;
  /** Shows the terminal to the user. */
  open?(address: string, title: string): Promise<void>;
}

export interface TerminalBackendOptions {
  readonly host: TerminalHost;
  /** Command that starts pi, before its arguments. */
  readonly piCommand: ReadonlyArray<string>;
}

export const execHc: HcRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("hc", [...args], { timeout: HC_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      let message = stderr.trim() || error.message;
      let kind: string | undefined;
      try {
        const parsed = (JSON.parse(message) as { error?: { message?: string; kind?: string } }).error;
        message = parsed?.message ?? message;
        kind = parsed?.kind;
      } catch {}
      reject(Object.assign(new Error(`hc ${args[0]}: ${message}`), { kind }));
    });
  });

/** hc names: 1-32 of a-z 0-9 - _, unique among live terminals. A suffix is added only after a collision. */
function terminalName(title: string, unique: boolean) {
  const slug = (max: number) =>
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "subagent";
  return unique ? `${slug(27)}-${randomBytes(2).toString("hex")}` : slug(32);
}

function parseAddress(stdout: string) {
  const address = (JSON.parse(stdout) as { address?: unknown }).address;
  if (typeof address !== "string" || !address) throw new Error(`hc run returned no address: ${stdout.slice(0, 200)}`);
  return address;
}

/** Terminals started from the parent's terminal, so Herdr lists them under the parent. */
export function hcHost(hc: HcRunner): TerminalHost {
  return {
    start: async ({ title, cwd, env, command }) => {
      const run = (unique: boolean) =>
        hc([
          "run",
          "--bg",
          "--json",
          // Exits are detected over the channel; hc notes would be typed into the
          // parent's prompt, or into its shell once the parent pi has exited.
          "--no-notify",
          "--name",
          terminalName(title, unique),
          "--cwd",
          cwd,
          "--",
          "env",
          ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
          ...command,
        ]);
      return parseAddress(
        await run(false).catch((error: { kind?: string }) => {
          if (error.kind === "name_taken") return run(true);
          throw error;
        }),
      );
    },
    isLive: async (address) => {
      try {
        return (JSON.parse(await hc(["get", address, "--json"])) as { state?: unknown }).state === "live";
      } catch {
        return false;
      }
    },
    stop: async (address) => {
      await hc(["kill", address]).catch(() => undefined);
      await hc(["rm", address]).catch(() => undefined);
    },
  };
}

interface HcState {
  closed: boolean;
  /** A run was requested or started and has not settled. */
  active: boolean;
  address: string | undefined;
  dir: string | undefined;
  stopTail: (() => void) | undefined;
  sessionFile: string | undefined;
  meta: SubagentMeta;
  settleWaiters: Array<() => void>;
  compactions: Map<string, (reply: CompactionReply) => void>;
}

const makeTerminalSession = (
  options: TerminalBackendOptions,
  task: SpawnTask,
  sessionFilePath?: string,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const { host } = options;
    const model = yield* Effect.try({
      try: () =>
        sessionFilePath || !task.parent.modelRegistry
          ? undefined
          : resolveChildModel(task.parent.modelRegistry, task.model, task.parent.inheritedModel),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    const thinking = sessionFilePath ? undefined : (task.reasoningEffort ?? task.parent.inheritedThinkingLevel);
    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const state: HcState = {
      closed: false,
      active: false,
      address: undefined,
      dir: undefined,
      stopTail: undefined,
      sessionFile: sessionFilePath,
      meta: {
        ...(model ? { modelLabel: `${model.provider}/${model.id}` } : {}),
        ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(sessionFilePath === undefined ? {} : { sessionFilePath }),
      },
      settleWaiters: [],
      compactions: new Map(),
    };

    const emit = (event: SubagentEvent) => {
      if (state.closed) return;
      if (event._tag === "RunStarted") state.active = true;
      if (event._tag === "RunSettled") {
        state.active = false;
        for (const waiter of state.settleWaiters.splice(0)) waiter();
      }
      if (event._tag === "MetaChanged") {
        state.meta = { ...state.meta, ...event.meta };
        if (event.meta.sessionFilePath) state.sessionFile = event.meta.sessionFilePath;
      }
      Queue.offerUnsafe(events, event);
    };
    const exited = () => {
      state.address = undefined;
      if (state.active)
        emit({ _tag: "RunSettled", outcome: { _tag: "Failed", errorText: "The subagent's pi exited." } });
    };
    const removeChannel = () => {
      state.stopTail?.();
      state.stopTail = undefined;
      if (state.dir) fs.rmSync(state.dir, { recursive: true, force: true });
      state.dir = undefined;
    };
    const command = (value: ParentCommand) => {
      if (!state.dir) throw new Error("The subagent has no channel.");
      appendLine(channelPaths(state.dir).inbox, value);
    };

    /** Start a terminal whose pi handles `first` first. */
    const launch = async (first: ParentCommand) => {
      removeChannel();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
      state.dir = dir;
      const paths = channelPaths(dir);
      fs.writeFileSync(paths.parentPid, String(process.pid), { mode: 0o600 });
      appendLine(paths.inbox, first);
      state.stopTail = tailJsonl(paths.events, (value) => {
        if (isCompactionReply(value)) state.compactions.get(value.id)?.(value);
        else if (isSubagentEvent(value)) emit(value);
      });
      const piArgs = [
        ...(state.sessionFile
          ? ["--session", state.sessionFile]
          : [
              "--name",
              task.title,
              ...(model ? ["--model", `${model.provider}/${model.id}`] : []),
              ...(thinking ? ["--thinking", thinking] : []),
            ]),
        task.parent.projectTrusted ? "--approve" : "--no-approve",
      ];
      state.active = first.type === "send";
      try {
        state.address = await host.start({
          title: task.title,
          cwd: task.cwd,
          env: { [CHANNEL_ENV]: dir },
          command: [...options.piCommand, ...piArgs],
        });
      } catch (error) {
        state.active = false;
        removeChannel();
        throw error;
      }
    };

    const liveness = setInterval(() => {
      const address = state.address;
      if (!address || !state.active) return;
      void host.isLive(address).then((live) => {
        if (!live && state.address === address) exited();
      });
    }, LIVENESS_MS);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearInterval(liveness);
        const address = state.address;
        state.closed = true;
        for (const waiter of state.settleWaiters.splice(0)) waiter();
        for (const [id, resolve] of state.compactions)
          resolve({ type: "compacted", id, errorText: "Subagent session is closed." });
        removeChannel();
        if (address) await host.stop(address);
        Queue.endUnsafe(events);
      }),
    );

    if (sessionFilePath) {
      yield* Effect.try({
        try: () => {
          const manager = SessionManager.open(sessionFilePath, undefined, task.cwd);
          replayTranscript(manager.buildSessionContext().messages, emit);
          emit({ _tag: "UsageChanged", cost: sessionCost(manager.getEntries()) });
        },
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      });
    } else {
      yield* Effect.tryPromise({
        try: () => launch({ type: "send", text: task.prompt }),
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      });
    }

    const toSendError = (error: unknown) => new SendError({ message: boundedError(error) });
    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.tryPromise({
          try: async () => {
            if (state.closed) throw new Error("Subagent session is closed.");
            if (state.address && (state.active || (await host.isLive(state.address)))) {
              state.active = true;
              command({ type: "send", text });
              return;
            }
            if (!state.sessionFile) throw new Error("The subagent's session file is unknown.");
            await launch({ type: "send", text });
          },
          catch: toSendError,
        }),
      compact: (instructions) =>
        Effect.tryPromise({
          try: async (): Promise<CompactionOutcome> => {
            if (state.closed) throw new Error("Subagent session is closed.");
            const id = randomBytes(4).toString("hex");
            let timer: ReturnType<typeof setTimeout> | undefined;
            const replied = new Promise<CompactionReply>((resolve) => {
              state.compactions.set(id, resolve);
              timer = setTimeout(
                () => resolve({ type: "compacted", id, errorText: "Compaction timed out." }),
                COMPACT_TIMEOUT_MS,
              );
            });
            const value: ParentCommand = {
              type: "compact",
              id,
              ...(instructions === undefined ? {} : { instructions }),
            };
            try {
              if (state.address && (await host.isLive(state.address))) command(value);
              else if (state.sessionFile) await launch(value);
              else throw new Error("The subagent's session file is unknown.");
              const reply = await replied;
              if (reply.errorText !== undefined || reply.tokensBefore === undefined)
                throw new Error(reply.errorText ?? "Compaction failed.");
              return {
                tokensBefore: reply.tokensBefore,
                ...(reply.estimatedTokensAfter === undefined
                  ? {}
                  : { estimatedTokensAfter: reply.estimatedTokensAfter }),
              };
            } finally {
              clearTimeout(timer);
              state.compactions.delete(id);
            }
          },
          catch: toSendError,
        }),
      answer: (questionId, text) =>
        Effect.try({
          try: () => command({ type: "answer", questionId, text }),
          catch: toSendError,
        }),
      interrupt: Effect.promise(async () => {
        if (!state.active || state.closed) return;
        if (!state.address || !(await host.isLive(state.address))) return exited();
        const settled = new Promise<void>((resolve) => {
          state.settleWaiters.push(resolve);
          setTimeout(resolve, INTERRUPT_WAIT_MS);
        });
        command({ type: "interrupt" });
        await settled;
      }),
      ...(host.open === undefined
        ? {}
        : {
            open: Effect.tryPromise({
              try: async () => {
                if (state.closed) throw new Error("Subagent session is closed.");
                if (!state.address || !(await host.isLive(state.address))) {
                  if (!state.sessionFile) throw new Error("The subagent's session file is unknown.");
                  // An interrupt with no run to stop starts the pi without giving it work.
                  await launch({ type: "interrupt" });
                }
                if (state.address) await host.open?.(state.address, task.title);
              },
              catch: toSendError,
            }),
          }),
    } satisfies SubagentSession;
  });

export function makeTerminalBackend(options: TerminalBackendOptions) {
  return {
    spawn: (task: SpawnTask) => makeTerminalSession(options, task),
    resume: (task: SpawnTask, sessionFilePath: string) => makeTerminalSession(options, task, sessionFilePath),
  };
}

export function makeHcBackend(options: { readonly hc: HcRunner; readonly piCommand: ReadonlyArray<string> }) {
  return makeTerminalBackend({ host: hcHost(options.hc), piCommand: options.piCommand });
}

/** Subagents run in herdr-core terminals when the parent runs in one. */
export function hcBackendAvailable() {
  return Boolean(process.env.HC_TERMINAL_ID);
}
