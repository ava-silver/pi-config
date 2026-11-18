/**
 * hc backend: each subagent is an interactive pi in its own herdr-core
 * terminal, started from the parent's terminal so Herdr lists it under the
 * parent. The child reports over a file channel (see ../channel.ts and
 * ../child.ts); hc only starts, checks, and stops the terminal.
 *
 * - spawn writes the prompt to the inbox, then starts the terminal;
 * - send/answer/interrupt append commands to the inbox;
 * - a send after the child's pi exited (or after restore) starts a new
 *   terminal on the same session file;
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
import { appendLine, CHANNEL_ENV, channelPaths, isSubagentEvent, type ParentCommand, tailJsonl } from "../channel.ts";
import type { SpawnTask, SubagentEvent, SubagentMeta, SubagentSession } from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { boundedError, replayTranscript } from "./pi-events.ts";

const HC_TIMEOUT_MS = 15_000;
const LIVENESS_MS = 3_000;
const INTERRUPT_WAIT_MS = 4_000;

/** Runs `hc` with arguments and resolves with its stdout. */
export type HcRunner = (args: ReadonlyArray<string>) => Promise<string>;

export interface HcBackendOptions {
  readonly hc: HcRunner;
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

async function isLive(hc: HcRunner, address: string) {
  try {
    return (JSON.parse(await hc(["get", address, "--json"])) as { state?: unknown }).state === "live";
  } catch {
    return false;
  }
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
}

const makeHcSession = (
  options: HcBackendOptions,
  task: SpawnTask,
  sessionFilePath?: string,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const { hc } = options;
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

    /** Start a terminal whose pi runs `text` first. */
    const launch = async (text: string) => {
      removeChannel();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
      state.dir = dir;
      const paths = channelPaths(dir);
      fs.writeFileSync(paths.parentPid, String(process.pid), { mode: 0o600 });
      appendLine(paths.inbox, { type: "send", text } satisfies ParentCommand);
      state.stopTail = tailJsonl(paths.events, (value) => {
        if (isSubagentEvent(value)) emit(value);
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
      const run = (unique: boolean) =>
        hc([
          "run",
          "--bg",
          "--json",
          // Exits are detected over the channel; hc notes would be typed into the
          // parent's prompt, or into its shell once the parent pi has exited.
          "--no-notify",
          "--name",
          terminalName(task.title, unique),
          "--cwd",
          task.cwd,
          "--",
          "env",
          `${CHANNEL_ENV}=${dir}`,
          ...options.piCommand,
          ...piArgs,
        ]);
      state.active = true;
      try {
        state.address = parseAddress(
          await run(false).catch((error: { kind?: string }) => {
            if (error.kind === "name_taken") return run(true);
            throw error;
          }),
        );
      } catch (error) {
        state.active = false;
        removeChannel();
        throw error;
      }
    };

    const liveness = setInterval(() => {
      const address = state.address;
      if (!address || !state.active) return;
      void isLive(hc, address).then((live) => {
        if (!live && state.address === address) exited();
      });
    }, LIVENESS_MS);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        clearInterval(liveness);
        const address = state.address;
        state.closed = true;
        for (const waiter of state.settleWaiters.splice(0)) waiter();
        removeChannel();
        if (address) {
          await hc(["kill", address]).catch(() => undefined);
          await hc(["rm", address]).catch(() => undefined);
        }
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
        try: () => launch(task.prompt),
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
            if (state.address && (state.active || (await isLive(hc, state.address)))) {
              state.active = true;
              command({ type: "send", text });
              return;
            }
            if (!state.sessionFile) throw new Error("The subagent's session file is unknown.");
            await launch(text);
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
        if (!state.address || !(await isLive(hc, state.address))) return exited();
        const settled = new Promise<void>((resolve) => {
          state.settleWaiters.push(resolve);
          setTimeout(resolve, INTERRUPT_WAIT_MS);
        });
        command({ type: "interrupt" });
        await settled;
      }),
    } satisfies SubagentSession;
  });

export function makeHcBackend(options: HcBackendOptions) {
  return {
    spawn: (task: SpawnTask) => makeHcSession(options, task),
    resume: (task: SpawnTask, sessionFilePath: string) => makeHcSession(options, task, sessionFilePath),
  };
}

/** Subagents run in herdr-core terminals when the parent runs in one. */
export function hcBackendAvailable() {
  return Boolean(process.env.HC_TERMINAL_ID);
}
