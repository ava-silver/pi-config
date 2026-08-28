/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped SubagentSession (spawned by spawnPiSession) plus
 * a pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import { Context, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from "effect";
import type {
	LiveToolState,
	RunOutcome,
	SpawnTask,
	SubagentEvent,
	SubagentMeta,
	SubagentQuestion,
	SubagentSession,
	SubagentSnapshot,
	SubagentStatus,
	TranscriptItem,
} from "./domain.ts";
import { spawnPiSession } from "./backends/pi.ts";
import { ConcurrencyLimitError, SendError, SpawnError } from "./domain.ts";

export const MAX_RUNNING = 16;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
	return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
	id: string;
	title: string;
	prompt: string;
	cwd: string;
	status: SubagentStatus;
	createdAt: number;
	settledAt?: number;
	errorText?: string;
	meta: SubagentMeta;
	usage: { tokens?: number; contextWindow?: number };
	cost: number;
	transcript: TranscriptItem[];
	liveAssistant?: { text: string; thinking: string };
	liveTools: LiveToolState[];
	queued: SubagentSnapshot["queued"];
	pendingQuestions: SubagentQuestion[];
	finalText: string;
	turns: number;
}

interface Entry {
	snapshot: MutableSnapshot;
	session: SubagentSession;
	scope: Scope.Closeable;
	pump?: Fiber.Fiber<void>;
	liveToolMap: Map<string, LiveToolState>;
	/** Idle restart dispatched but RunStarted not folded yet; counts as running
	 * so concurrent restarts cannot race past the cap. */
	restarting?: boolean;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
	list(): ReadonlyArray<SubagentSnapshot>;
	get(id: string): SubagentSnapshot | undefined;
	size(): number;
	/** Any-change notification (footer status, dashboard). */
	subscribe(listener: () => void): () => void;
	/** Per-subagent notification (takeover view). */
	subscribeTo(id: string, listener: () => void): () => void;
	/** Fire-and-forget: steer/continue a subagent (takeover input). */
	requestSend(id: string, text: string): void;
	/** Fire-and-forget: answer the oldest pending question (takeover input). */
	requestAnswer(id: string, text: string): void;
	/** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
	requestAbort(id: string): void;
	/**
	 * Register the settle hook. `consumed` is true when an active
	 * subagent_wait/cancel is collecting the result (so it must not also be
	 * delivered as a follow-up message).
	 */
	setOnSettled(hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined): void;
	setOnQuestion(hook: ((snap: SubagentSnapshot, question: SubagentQuestion) => void) | undefined): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult {
	readonly id: string;
	readonly title: string;
	readonly status: SubagentStatus;
	readonly cancelled: boolean;
}

export interface SubagentManagerShape {
	spawn(task: SpawnTask): Effect.Effect<SubagentSnapshot, SpawnError | ConcurrencyLimitError>;
	/**
	 * Wait until all listed subagents are settled. Unknown ids are treated as
	 * settled (the tool layer validates ids first). While waiting, settles for
	 * these ids are marked "consumed". Interruption (tool abort) releases the
	 * interest and leaves the subagents running.
	 */
	waitFor(ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void): Effect.Effect<void>;
	/** Cancel running subagents; resolves when they have settled. */
	cancel(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<CancelResult>>;
	send(id: string, text: string): Effect.Effect<void, SendError>;
	answer(id: string, text: string): Effect.Effect<SubagentQuestion, SendError>;
	get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
	readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
	readonly disposeAll: Effect.Effect<void>;
	readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<SubagentManager, SubagentManagerShape>()(
	"subagents/SubagentManager",
) {}

// --- Implementation --------------------------------------------------------------

type SpawnFn = (task: SpawnTask) => Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
type RunDetached = <A, E>(effect: Effect.Effect<A, E, never>) => Fiber.Fiber<A, E>;

interface ManagerState {
	entries: Map<string, Entry>;
	waitInterest: Map<string, number>;
	listeners: Set<() => void>;
	changeWaiters: Array<() => void>;
	idListeners: Map<string, Set<() => void>>;
	cleanups: Set<Fiber.Fiber<unknown>>;
	runDetached: RunDetached;
	counter: number;
	reserved: number;
	disposed: boolean;
	onSettled: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;
	onQuestion: ((snap: SubagentSnapshot, question: SubagentQuestion) => void) | undefined;
}

function createManagerState(runDetached: RunDetached): ManagerState {
	return {
		entries: new Map(),
		waitInterest: new Map(),
		listeners: new Set(),
		changeWaiters: [],
		idListeners: new Map(),
		cleanups: new Set(),
		runDetached,
		counter: 0,
		reserved: 0,
		disposed: false,
		onSettled: undefined,
		onQuestion: undefined,
	};
}

function notify(state: ManagerState, id?: string) {
	const waiters = state.changeWaiters;
	state.changeWaiters = [];
	for (const waiter of waiters) waiter();
	for (const listener of Array.from(state.listeners)) {
		try {
			listener();
		} catch {}
	}
	if (!id) return;
	for (const listener of state.idListeners.get(id) ?? []) {
		try {
			listener();
		} catch {}
	}
}

function nextChange(state: ManagerState) {
	return Effect.callback<void>((resume) => {
		const waiter = () => resume(Effect.void);
		state.changeWaiters.push(waiter);
		return Effect.sync(() => {
			const index = state.changeWaiters.indexOf(waiter);
			if (index >= 0) state.changeWaiters.splice(index, 1);
		});
	});
}

function runningCount(state: ManagerState) {
	return [...state.entries.values()].filter((entry) => entry.snapshot.status === "running" || entry.restarting === true)
		.length;
}

function addInterest(state: ManagerState, ids: ReadonlyArray<string>) {
	for (const id of ids) state.waitInterest.set(id, (state.waitInterest.get(id) ?? 0) + 1);
}

function releaseInterest(state: ManagerState, ids: ReadonlyArray<string>) {
	for (const id of ids) {
		const count = (state.waitInterest.get(id) ?? 1) - 1;
		if (count <= 0) state.waitInterest.delete(id);
		else state.waitInterest.set(id, count);
	}
}

function closeEntryScope(entry: Entry) {
	return Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
}

function pruneSettled(state: ManagerState) {
	if (state.entries.size <= MAX_TRACKED) return;
	const candidates = [...state.entries.values()]
		.filter((entry) => entry.snapshot.status !== "running" && !state.waitInterest.has(entry.snapshot.id))
		.sort((a, b) => (a.snapshot.settledAt ?? a.snapshot.createdAt) - (b.snapshot.settledAt ?? b.snapshot.createdAt));
	for (const entry of candidates) {
		if (state.entries.size <= MAX_TRACKED) break;
		state.entries.delete(entry.snapshot.id);
		const fiber = state.runDetached(closeEntryScope(entry));
		state.cleanups.add(fiber);
		fiber.addObserver(() => state.cleanups.delete(fiber));
	}
}

function settle(state: ManagerState, entry: Entry, outcome: RunOutcome) {
	const snapshot = entry.snapshot;
	entry.restarting = false;
	if (snapshot.status !== "running") return;
	snapshot.settledAt = Date.now();
	switch (outcome._tag) {
		case "Completed":
			snapshot.status = "done";
			delete snapshot.errorText;
			snapshot.finalText = outcome.finalText;
			break;
		case "Failed":
			snapshot.status = "error";
			snapshot.errorText = bounded(outcome.errorText);
			snapshot.finalText = outcome.partialText ?? "";
			break;
		case "Interrupted":
			snapshot.status = "error";
			snapshot.errorText = "Run was aborted";
			snapshot.finalText = outcome.partialText ?? "";
			break;
	}
	delete snapshot.liveAssistant;
	entry.liveToolMap.clear();
	snapshot.liveTools = [];
	snapshot.queued = [];
	snapshot.pendingQuestions = [];
	const consumed = (state.waitInterest.get(snapshot.id) ?? 0) > 0;
	notify(state, snapshot.id);
	try {
		if (!state.disposed) state.onSettled?.(snapshot, consumed);
	} catch {}
	pruneSettled(state);
}

function foldEvent(state: ManagerState, entry: Entry, event: SubagentEvent) {
	const snapshot = entry.snapshot;
	switch (event._tag) {
		case "RunStarted":
			entry.restarting = false;
			snapshot.status = "running";
			delete snapshot.settledAt;
			delete snapshot.errorText;
			break;
		case "RunSettled":
			settle(state, entry, event.outcome);
			return;
		case "UserMessage":
			snapshot.transcript.push({ kind: "user", text: event.text });
			break;
		case "AssistantDelta": {
			const live = snapshot.liveAssistant ?? { text: "", thinking: "" };
			snapshot.liveAssistant =
				event.kind === "text"
					? { ...live, text: live.text + event.delta }
					: { ...live, thinking: live.thinking + event.delta };
			break;
		}
		case "AssistantMessage":
			snapshot.transcript.push({ kind: "assistant", parts: event.parts });
			if (typeof event.cost === "number" && Number.isFinite(event.cost)) snapshot.cost += event.cost;
			delete snapshot.liveAssistant;
			snapshot.turns++;
			break;
		case "ToolStart":
			entry.liveToolMap.set(event.toolId, {
				toolId: event.toolId,
				name: event.name,
				...(event.argsPreview === undefined ? {} : { argsPreview: event.argsPreview }),
			});
			snapshot.liveTools = [...entry.liveToolMap.values()];
			break;
		case "ToolUpdate": {
			const current = entry.liveToolMap.get(event.toolId);
			if (current) {
				entry.liveToolMap.set(event.toolId, {
					...current,
					...(event.outputPreview === undefined ? {} : { outputPreview: event.outputPreview }),
				});
				snapshot.liveTools = [...entry.liveToolMap.values()];
			}
			break;
		}
		case "ToolEnd":
			entry.liveToolMap.delete(event.toolId);
			snapshot.liveTools = [...entry.liveToolMap.values()];
			snapshot.transcript.push({
				kind: "toolResult",
				toolId: event.toolId,
				name: event.name,
				isError: event.isError,
				...(event.outputPreview === undefined ? {} : { outputPreview: event.outputPreview }),
			});
			break;
		case "QueueChanged":
			snapshot.queued = event.queued;
			break;
		case "QuestionAsked":
			snapshot.pendingQuestions.push(event.question);
			try {
				state.onQuestion?.(snapshot, event.question);
			} catch {}
			break;
		case "QuestionClosed":
			snapshot.pendingQuestions = snapshot.pendingQuestions.filter((question) => question.id !== event.questionId);
			break;
		case "UsageChanged": {
			const tokens = event.tokens ?? snapshot.usage.tokens;
			const contextWindow = event.contextWindow ?? snapshot.usage.contextWindow;
			snapshot.usage = {
				...(tokens === undefined ? {} : { tokens }),
				...(contextWindow === undefined ? {} : { contextWindow }),
			};
			break;
		}
		case "MetaChanged":
			snapshot.meta = { ...snapshot.meta, ...event.meta };
			break;
	}
	notify(state, snapshot.id);
}

function spawn(state: ManagerState, spawnFn: SpawnFn, task: SpawnTask) {
	return Effect.gen(function* () {
		yield* Effect.suspend((): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
			if (state.disposed)
				return new SpawnError({
					message: "Subagent manager is shutting down.",
				});
			if (runningCount(state) + state.reserved >= MAX_RUNNING)
				return new ConcurrencyLimitError({
					message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish (subagent_wait) before spawning another.`,
				});
			state.reserved++;
			return Effect.void;
		});
		const doSpawn = Effect.gen(function* () {
			const scope = yield* Scope.make();
			const session = yield* Scope.provide(spawnFn(task), scope).pipe(
				Effect.onError(() => Scope.close(scope, Exit.void)),
			);
			if (state.disposed) {
				yield* Scope.close(scope, Exit.void);
				return yield* new SpawnError({
					message: "Subagent manager shut down while spawning.",
				});
			}
			const id = `sa-${++state.counter}`;
			const meta = yield* session.meta;
			const entry: Entry = {
				snapshot: {
					id,
					title: task.title,
					prompt: task.prompt,
					cwd: task.cwd,
					status: "running",
					createdAt: Date.now(),
					meta,
					usage: meta.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow },
					cost: 0,
					transcript: [],
					liveTools: [],
					queued: [],
					pendingQuestions: [],
					finalText: "",
					turns: 0,
				},
				session,
				scope,
				liveToolMap: new Map(),
			};
			state.entries.set(id, entry);
			const pump = Stream.runForEach(session.events, (event) => Effect.sync(() => foldEvent(state, entry, event))).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						if (entry.snapshot.status === "running")
							settle(state, entry, {
								_tag: "Failed",
								errorText: "Backend event stream ended unexpectedly",
							});
					}),
				),
			);
			entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);
			notify(state, id);
			return entry.snapshot as SubagentSnapshot;
		});
		return yield* doSpawn.pipe(
			Effect.ensuring(
				Effect.sync(() => {
					state.reserved--;
					notify(state);
				}),
			),
		);
	});
}

function waitFor(state: ManagerState, ids: ReadonlyArray<string>, onPending?: (pending: string[]) => void) {
	return Effect.suspend(() => {
		const unique = [...new Set(ids)];
		addInterest(state, unique);
		return Effect.gen(function* () {
			while (true) {
				const pending = unique.filter((id) => {
					const snapshot = state.entries.get(id)?.snapshot;
					return snapshot?.status === "running" && snapshot.pendingQuestions.length === 0;
				});
				if (pending.length === 0) return;
				onPending?.(pending);
				yield* nextChange(state);
			}
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					releaseInterest(state, unique);
					pruneSettled(state);
				}),
			),
		);
	});
}

function abortEntry(state: ManagerState, entry: Entry) {
	return Effect.gen(function* () {
		if (entry.snapshot.status !== "running") return;
		const graceful = yield* entry.session.interrupt.pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.result);
		if (Result.isFailure(graceful)) {
			yield* Effect.sync(() => {
				settle(state, entry, { _tag: "Interrupted" });
				entry.snapshot.errorText = "Abort deadline exceeded; session was force-disposed";
				notify(state, entry.snapshot.id);
			});
			yield* closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore);
		}
	});
}

function cancel(state: ManagerState, ids: ReadonlyArray<string>) {
	return Effect.suspend(() => {
		const unique = [...new Set(ids)];
		const running = unique
			.map((id) => state.entries.get(id))
			.filter((entry): entry is Entry => entry?.snapshot.status === "running");
		const runningIds = running.map((entry) => entry.snapshot.id);
		addInterest(state, runningIds);
		const work = Effect.gen(function* () {
			yield* Effect.forEach(running, (entry) => abortEntry(state, entry), {
				concurrency: "unbounded",
			});
			while (running.some((entry) => entry.snapshot.status === "running")) yield* nextChange(state);
		});
		return work.pipe(
			Effect.ensuring(
				Effect.sync(() => {
					releaseInterest(state, runningIds);
					pruneSettled(state);
				}),
			),
			Effect.map((): ReadonlyArray<CancelResult> =>
				unique.map((id) => {
					const snapshot = state.entries.get(id)?.snapshot;
					return {
						id,
						title: snapshot?.title ?? "?",
						status: snapshot?.status ?? "error",
						cancelled: runningIds.includes(id),
					};
				}),
			),
		);
	});
}

function send(state: ManagerState, id: string, text: string) {
	return Effect.suspend((): Effect.Effect<void, SendError> => {
		const entry = state.entries.get(id);
		if (!entry || state.disposed)
			return new SendError({
				message: `Subagent "${id}" is no longer tracked.`,
			});
		if (entry.snapshot.status === "running") return entry.session.send(text);
		if (runningCount(state) + state.reserved >= MAX_RUNNING)
			return new SendError({
				message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
			});
		entry.restarting = true;
		return entry.session.send(text).pipe(
			Effect.onError(() =>
				Effect.sync(() => {
					entry.restarting = false;
				}),
			),
		);
	});
}

function answer(state: ManagerState, id: string, text: string) {
	return Effect.suspend((): Effect.Effect<SubagentQuestion, SendError> => {
		const entry = state.entries.get(id);
		const question = entry?.snapshot.pendingQuestions[0];
		if (!entry || !question || state.disposed)
			return new SendError({
				message: `Subagent "${id}" has no pending question.`,
			});
		return entry.session.answer(question.id, text).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					entry.snapshot.pendingQuestions = entry.snapshot.pendingQuestions.filter(
						(pending) => pending.id !== question.id,
					);
					notify(state, id);
				}),
			),
			Effect.as(question),
		);
	});
}

function disposeAll(state: ManagerState) {
	return Effect.gen(function* () {
		state.disposed = true;
		const all = [...state.entries.values()];
		state.entries.clear();
		yield* Effect.forEach(all, (entry) => closeEntryScope(entry).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore), {
			concurrency: "unbounded",
		});
		yield* Effect.forEach(
			[...state.cleanups],
			(fiber) => Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
			{ concurrency: "unbounded" },
		).pipe(Effect.ignore);
		yield* Effect.sync(() => notify(state));
	});
}

function createView(state: ManagerState): SubagentReadModel {
	return {
		list: () => [...state.entries.values()].map((entry) => entry.snapshot),
		get: (id) => state.entries.get(id)?.snapshot,
		size: () => state.entries.size,
		subscribe: (listener) => {
			state.listeners.add(listener);
			return () => state.listeners.delete(listener);
		},
		subscribeTo: (id, listener) => {
			let set = state.idListeners.get(id);
			if (!set) {
				set = new Set();
				state.idListeners.set(id, set);
			}
			set.add(listener);
			return () => {
				set.delete(listener);
				if (set.size === 0) state.idListeners.delete(id);
			};
		},
		requestSend: (id, text) => {
			state.runDetached(send(state, id, text).pipe(Effect.ignore));
		},
		requestAnswer: (id, text) => {
			state.runDetached(answer(state, id, text).pipe(Effect.ignore));
		},
		requestAbort: (id) => {
			const entry = state.entries.get(id);
			if (entry) state.runDetached(abortEntry(state, entry).pipe(Effect.ignore));
		},
		setOnSettled: (hook) => {
			state.onSettled = hook;
		},
		setOnQuestion: (hook) => {
			state.onQuestion = hook;
		},
	};
}

const makeManager = (spawnFn: SpawnFn) =>
	Effect.gen(function* () {
		const state = createManagerState(Effect.runForkWith(yield* Effect.context()));
		const view = createView(state);
		const dispose = disposeAll(state);
		return yield* Effect.addFinalizer(() => dispose).pipe(
			Effect.as(
				SubagentManager.of({
					spawn: (task) => spawn(state, spawnFn, task),
					waitFor: (ids, onPending) => waitFor(state, ids, onPending),
					cancel: (ids) => cancel(state, ids),
					send: (id, text) => send(state, id, text),
					answer: (id, text) => answer(state, id, text),
					get: (id) => Effect.sync(() => state.entries.get(id)?.snapshot),
					list: Effect.sync(() => [...state.entries.values()].map((entry) => entry.snapshot)),
					disposeAll: dispose,
					view,
				}),
			),
		);
	});

export function makeSubagentManagerLayer(spawnFn: SpawnFn) {
	return Layer.effect(SubagentManager, makeManager(spawnFn));
}

export const SubagentManagerLive = makeSubagentManagerLayer(spawnPiSession);
