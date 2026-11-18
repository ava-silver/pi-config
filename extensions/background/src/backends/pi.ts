/**
 * pi backend -- real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts + shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and the child tool denylist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run or starts a fresh prompt() when idle;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import { createParentQuestions } from "../ask-parent.ts";
import type { SpawnTask, SubagentEvent, SubagentMeta, SubagentSession } from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { boundedError, type Emit, finalOutput, messageRole, replayTranscript, translateActivity } from "./pi-events.ts";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  resolveChildModel,
  shutdownAndDisposeChildSession,
  waitForChildSessionOperation,
} from "../../../shared/child-session.ts";
import { sessionCost } from "../../../shared/session-cost.ts";
import { createToolCallTimeoutGuard } from "../../../shared/tool-call-timeout.ts";

type ThinkingLevel = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]>;

// --- The session ------------------------------------------------------------------

interface PiSessionState {
  closed: boolean;
  runError: string | undefined;
  settled: boolean;
}

type ParentQuestions = ReturnType<typeof createParentQuestions>;

function lastAssistantMessage(session: AgentSession): AssistantMessage | undefined {
  return session.messages.findLast((msg) => messageRole(msg) === "assistant") as AssistantMessage | undefined;
}

interface ChildSessionSetup {
  task: SpawnTask;
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  askParentTool: ParentQuestions["tool"];
  sessionFilePath?: string;
}

function createChildSession(setup: ChildSessionSetup) {
  return Effect.tryPromise({
    try: async () => {
      const { loader, settingsManager } = await createChildResources({
        cwd: setup.task.cwd,
        projectTrusted: setup.task.parent.projectTrusted,
      });
      const { session } = await createAgentSession({
        cwd: setup.task.cwd,
        sessionManager: setup.sessionFilePath
          ? SessionManager.open(setup.sessionFilePath, undefined, setup.task.cwd)
          : SessionManager.create(setup.task.cwd),
        settingsManager,
        resourceLoader: loader,
        ...(setup.model === undefined ? {} : { model: setup.model }),
        ...(setup.thinkingLevel === undefined ? {} : { thinkingLevel: setup.thinkingLevel }),
        customTools: [setup.askParentTool],
        ...childToolPolicy(),
      });
      try {
        await bindChildSessionExtensions(session);
      } catch (error) {
        await shutdownAndDisposeChildSession(session);
        throw error;
      }
      return session;
    },
    catch: (error) => new SpawnError({ message: boundedError(error) }),
  });
}

interface SessionControl {
  currentMeta(): SubagentMeta;
  emitUsage(): void;
  handleEvent(event: AgentSessionEvent): void;
  startRun(text: string): void;
}

interface SessionControlSetup {
  session: AgentSession;
  registry: NonNullable<SpawnTask["parent"]["modelRegistry"]>;
  state: PiSessionState;
  emit: Emit;
  toolTimeout: ReturnType<typeof createToolCallTimeoutGuard>;
}

function createSessionControl(setup: SessionControlSetup): SessionControl {
  const { session, registry, state, emit, toolTimeout } = setup;
  const activeModel = (): Model<any> | undefined => {
    const sessionModel = session.model;
    const last = lastAssistantMessage(session);
    if (!last || (sessionModel && (last.provider !== sessionModel.provider || last.model !== sessionModel.id)))
      return sessionModel;
    return registry.find(last.provider, last.responseModel ?? last.model) ?? sessionModel;
  };
  const currentMeta = (): SubagentMeta => {
    const model = activeModel();
    return {
      ...(model ? { modelLabel: `${model.provider}/${model.id}` } : {}),
      ...(model?.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(session.sessionFile === undefined ? {} : { sessionFilePath: session.sessionFile }),
    };
  };
  const emitUsage = () => {
    const usage = session.getContextUsage();
    const tokens = usage?.tokens;
    const contextWindow = activeModel()?.contextWindow ?? usage?.contextWindow;
    emit({
      _tag: "UsageChanged",
      ...(typeof tokens === "number" ? { tokens } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      cost: sessionCost(session.sessionManager.getEntries()),
    });
  };
  const settle = () => {
    if (state.settled) return;
    state.settled = true;
    const last = lastAssistantMessage(session);
    const partialText = finalOutput(session.messages) || undefined;
    if (last?.stopReason === "aborted") {
      emit({
        _tag: "RunSettled",
        outcome: {
          _tag: "Interrupted",
          ...(partialText === undefined ? {} : { partialText }),
        },
      });
      return;
    }
    const errorText =
      state.runError ?? (last?.stopReason === "error" ? (last.errorMessage ?? "Run failed") : undefined);
    if (errorText !== undefined) {
      emit({
        _tag: "RunSettled",
        outcome: {
          _tag: "Failed",
          errorText: boundedError(errorText),
          ...(partialText === undefined ? {} : { partialText }),
        },
      });
      return;
    }
    emit({
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: finalOutput(session.messages) },
    });
  };
  const handleEvent = (event: AgentSessionEvent) => {
    if (state.closed) return;
    switch (event.type) {
      case "agent_start":
        toolTimeout.apply(session);
        state.settled = false;
        emit({ _tag: "RunStarted" });
        break;
      case "message_update":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        translateActivity(event, emit);
        break;
      case "message_end":
        translateActivity(event, emit);
        if (messageRole(event.message) === "assistant") {
          emitUsage();
          emit({ _tag: "MetaChanged", meta: currentMeta() });
        }
        break;
      case "queue_update":
        emit({
          _tag: "QueueChanged",
          queued: [
            ...event.steering.map((text) => ({ text, kind: "steer" as const })),
            ...event.followUp.map((text) => ({
              text,
              kind: "follow-up" as const,
            })),
          ],
        });
        break;
      case "entry_appended":
        emitUsage();
        break;
      case "agent_settled":
        settle();
        break;
    }
  };
  const startRun = (text: string) => {
    state.runError = undefined;
    state.settled = false;
    emit({ _tag: "RunStarted" });
    void session.prompt(text).catch((error) => {
      state.runError = boundedError(error);
      if (!session.isStreaming) settle();
    });
  };
  return { currentMeta, emitUsage, handleEvent, startRun };
}

interface FinalizerSetup {
  session: AgentSession;
  state: PiSessionState;
  questions: ParentQuestions;
  unsubscribe: () => void;
  events: Queue.Queue<SubagentEvent, Cause.Done>;
}

function closePiSession(setup: FinalizerSetup) {
  return Effect.promise(async () => {
    setup.state.closed = true;
    setup.questions.close();
    setup.unsubscribe();
    try {
      setup.session.clearQueue();
    } catch {}
    await waitForChildSessionOperation(setup.session.abort(), 5_000);
    await shutdownAndDisposeChildSession(setup.session);
    Queue.endUnsafe(setup.events);
  });
}

function interruptPiSession(session: AgentSession, state: PiSessionState, emit: Emit) {
  return Effect.promise(async () => {
    if (state.closed) return;
    try {
      session.clearQueue();
    } catch {}
    await session.abort().catch(() => undefined);
    while (!state.closed && session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!state.closed && !state.settled) {
      state.settled = true;
      emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
    }
  });
}

const makePiSession = (
  task: SpawnTask,
  sessionFilePath?: string,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    if (!registry)
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    // A resumed session keeps the model and thinking level its file records.
    const model = yield* Effect.try({
      try: () => (sessionFilePath ? undefined : resolveChildModel(registry, task.model, task.parent.inheritedModel)),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    const thinkingLevel = sessionFilePath
      ? undefined
      : ((task.reasoningEffort ?? task.parent.inheritedThinkingLevel) as ThinkingLevel | undefined);
    const state: PiSessionState = {
      closed: false,
      runError: undefined,
      settled: false,
    };
    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit: Emit = (event) => {
      if (!state.closed) Queue.offerUnsafe(events, event);
    };
    const questions = createParentQuestions(emit);
    const session = yield* createChildSession({
      task,
      model,
      thinkingLevel,
      askParentTool: questions.tool,
      ...(sessionFilePath === undefined ? {} : { sessionFilePath }),
    });
    const toolTimeout = createToolCallTimeoutGuard();
    toolTimeout.apply(session);
    const control = createSessionControl({
      session,
      registry,
      state,
      emit,
      toolTimeout,
    });
    const unsubscribe = session.subscribe((event) => control.handleEvent(event));
    yield* Effect.addFinalizer(() => closePiSession({ session, state, questions, unsubscribe, events }));
    yield* Effect.try(() => session.sessionManager.appendSessionInfo(`subagent: ${task.title}`)).pipe(Effect.ignore);
    emit({ _tag: "MetaChanged", meta: control.currentMeta() });
    if (sessionFilePath) {
      replayTranscript(session.messages, emit);
      control.emitUsage();
    } else control.startRun(task.prompt);
    return {
      meta: Effect.sync(() => control.currentMeta()),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) return new SendError({ message: "Subagent session is closed." });
          if (session.isStreaming)
            return Effect.tryPromise({
              try: () => session.steer(text),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          control.startRun(text);
          return Effect.void;
        }),
      answer: (questionId, text) =>
        Effect.suspend((): Effect.Effect<void, SendError> =>
          questions.answer(questionId, text)
            ? Effect.void
            : new SendError({ message: `Question "${questionId}" is no longer pending.` }),
        ),
      interrupt: interruptPiSession(session, state, emit),
    } satisfies SubagentSession;
  });

export const spawnPiSession = (task: SpawnTask) => makePiSession(task);

export const resumePiSession = (task: SpawnTask, sessionFilePath: string) => makePiSession(task, sessionFilePath);
