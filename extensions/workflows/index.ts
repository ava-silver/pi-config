/**
 * workflows: model-authored multi-agent orchestration.
 *
 * A `workflow` tool that runs a JavaScript orchestration script written inline
 * by the model. The script executes ordered phases, fanning work out to
 * isolated subagents:
 *
 *   export const meta = { name, description, phases: [{ title, detail? }] }
 *   phase(title)                                  // mark runtime phase progression
 *   await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? })
 *   await parallel([() => agent(...), ...], { concurrency? })
 *   args                                          // parsed JSON args passed with the tool call
 *
 * `agent()` always resolves to `{ ok, output, structured?, error? }` — it
 * never throws into the script. Scripts branch on `ok` explicitly.
 *
 * Runs are blocking by default (live progress in the tool block). Pass
 * `background: true` to return immediately and get a follow-up message when
 * the run finishes. Run artifacts (script, args, statuses, result) are saved
 * under `~/.pi/agent/workflows/<runId>/` for inspection; result and bounded
 * transcripts use separate artifacts, and there is no resume.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getAgentDir,
	getMarkdownTheme,
	keyHint,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { registerTransientSegment } from "../shared/footer-segments.ts";
import { createWorkflowPersistence, persistWorkflowJson } from "./artifacts.ts";
import { RunController } from "./controller.ts";
import { sessionWorkflowRunIds, showWorkflowDashboard } from "./dashboard.ts";
import { extractMeta, prepareWorkflowScript, type WorkflowMeta } from "./meta.ts";
import {
	agentContext,
	aggregateUsage,
	countStates,
	emptyUsage,
	formatElapsed,
	formatUsage,
	phaseGroups,
	resultJson,
	stateSquare,
	statusColor,
	statusWord,
	SQUARE,
	type AgentRecord,
	type WorkflowDetails,
} from "./model.ts";
import {
	buildBackgroundWorkflowFollowUp,
	buildBackgroundWorkflowLaunchResult,
	buildWorkflowAgentPrompt,
	buildWorkflowResultMessage,
	WORKFLOW_PARAMETER_DESCRIPTIONS,
	WORKFLOW_PROMPT_GUIDELINES,
	WORKFLOW_PROMPT_SNIPPET,
	WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { createWorkflowResources, runAgent, type ThinkingLevel, type WorkflowModel } from "./runner.ts";
import { runWorkflowSandbox } from "./sandbox.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

const PREVIEW_LENGTH = 200;
const EMIT_INTERVAL_MS = 120;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** What `agent()` resolves to inside the script. */
interface ScriptAgentResult {
	ok: boolean;
	output: string;
	structured?: unknown;
	error?: string;
}

interface AgentCallOptions {
	label?: unknown;
	phase?: unknown;
	schema?: unknown;
	model?: unknown;
	provider?: unknown;
	effort?: unknown;
}

const WorkflowParams = Type.Object({
	script: Type.String({
		description: WORKFLOW_PARAMETER_DESCRIPTIONS.script,
	}),
	args: Type.Optional(
		Type.String({
			description: WORKFLOW_PARAMETER_DESCRIPTIONS.args,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description: WORKFLOW_PARAMETER_DESCRIPTIONS.background,
		}),
	),
});

type WorkflowInput = Static<typeof WorkflowParams>;

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 16 * 1024);
}

function summaryLine(details: WorkflowDetails): string {
	const { done, failed } = countStates(details);
	const settled = done + failed;
	return `workflow ${details.name ?? details.runId}: ${settled}/${details.agents.length} agents${
		details.currentPhase ? ` · ${details.currentPhase}` : ""
	}`;
}

function compactToolDetails(details: WorkflowDetails): WorkflowDetails {
	return {
		...details,
		...(details.result !== undefined
			? {
					result: JSON.parse(safeStringify(details.result, { maxBytes: 64 * 1024 })),
				}
			: {}),
		agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
	};
}

interface RunSummary {
	runId: string;
	name?: string;
	status: string;
	done: number;
	total: number;
	startedAt: number;
	active: boolean;
}

async function listRuns(
	activeRuns: Map<string, WorkflowDetails>,
	sessionId: string,
	referencedRunIds: ReadonlySet<string>,
): Promise<RunSummary[]> {
	const base = path.join(getAgentDir(), "workflows");
	const names = await fs.readdir(base).catch(() => [] as string[]);
	const summaries: RunSummary[] = [];
	for (const runId of names.filter((name) => name.startsWith("wf_"))) {
		const live = activeRuns.get(runId);
		if (live) {
			const { done, failed } = countStates(live);
			summaries.push({
				runId,
				...(live.name === undefined ? {} : { name: live.name }),
				status: live.status,
				done: done + failed,
				total: live.agents.length,
				startedAt: live.startedAt,
				active: true,
			});
			continue;
		}
		try {
			const parsed = JSON.parse(
				await fs.readFile(path.join(base, runId, "workflow.json"), "utf8"),
			) as Partial<WorkflowDetails>;
			if (parsed.sessionId !== sessionId && !referencedRunIds.has(runId)) continue;
			const agents = parsed.agents ?? [];
			summaries.push({
				runId,
				...(parsed.name === undefined ? {} : { name: parsed.name }),
				status: parsed.status === "running" ? "aborted" : (parsed.status ?? "unknown"),
				done: agents.filter((agent) => agent.state !== "running").length,
				total: agents.length,
				startedAt: parsed.startedAt ?? 0,
				active: false,
			});
		} catch {
			// Ignore unreadable artifacts because their session cannot be verified.
		}
	}
	return summaries.sort((a, b) => b.startedAt - a.startedAt);
}

async function runDetailText(run: RunSummary, activeRuns: Map<string, WorkflowDetails>): Promise<string> {
	const runDir = path.join(getAgentDir(), "workflows", run.runId);
	const live = activeRuns.get(run.runId);
	if (live) return buildWorkflowResultMessage(live, runDir);
	try {
		const parsed = JSON.parse(await fs.readFile(path.join(runDir, "workflow.json"), "utf8")) as WorkflowDetails;
		return buildWorkflowResultMessage(parsed, runDir);
	} catch {
		return `Run ${run.runId} — ${run.status}`;
	}
}

interface ActiveWorkflowRun {
	details: WorkflowDetails;
	controller: RunController;
	completion?: Promise<void>;
}

interface WorkflowState {
	activeRuns: Map<string, ActiveWorkflowRun>;
	lastUi: ExtensionContext["ui"] | undefined;
	completedRuns: number;
	failedRuns: number;
}

type WorkflowTool = Parameters<ExtensionAPI["registerTool"]>[0];
type WorkflowExecute = NonNullable<WorkflowTool["execute"]>;
type WorkflowExecuteArgs = Parameters<WorkflowExecute>;
type WorkflowRenderResultArgs = Parameters<NonNullable<WorkflowTool["renderResult"]>>;

interface WorkflowExecutionOptions {
	pi: ExtensionAPI;
	state: WorkflowState;
	params: WorkflowInput;
	signal: WorkflowExecuteArgs[2];
	onUpdate: WorkflowExecuteArgs[3];
	ctx: ExtensionContext;
}

interface WorkflowProgressEmitter {
	emit: (checkpoint?: boolean) => void;
	flushNow: () => void;
}

function applyAgentOutcome(
	record: AgentRecord,
	outcome: Awaited<ReturnType<typeof runAgent>>,
	emit: () => void,
): ScriptAgentResult {
	record.usage = outcome.usage;
	record.model = outcome.model ?? record.model;
	record.contextWindow = outcome.contextWindow ?? record.contextWindow;
	record.transcript = outcome.transcript;
	record.preview = (outcome.output || record.preview).slice(0, PREVIEW_LENGTH);
	record.finishedAt = Date.now();
	record.state = outcome.ok ? "done" : "error";
	if (outcome.ok) delete record.error;
	else record.error = outcome.error ?? "Agent failed";
	emit();
	return {
		ok: outcome.ok,
		output: outcome.output,
		...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
		...(outcome.error !== undefined ? { error: outcome.error } : {}),
	};
}

function createProgressEmitter({
	background,
	details,
	persistence,
	onUpdate,
}: {
	background: boolean;
	details: WorkflowDetails;
	persistence: ReturnType<typeof createWorkflowPersistence>;
	onUpdate: WorkflowExecuteArgs[3];
}): WorkflowProgressEmitter {
	let emitTimer: ReturnType<typeof setTimeout> | undefined;
	let lastEmit = 0;
	const flush = () => {
		emitTimer = undefined;
		lastEmit = Date.now();
		if (background) return;
		onUpdate?.({
			content: [{ type: "text", text: summaryLine(details) }],
			details: compactToolDetails(details),
		});
	};
	return {
		emit(checkpoint = true) {
			if (checkpoint) persistence.checkpoint();
			if (emitTimer) return;
			emitTimer = setTimeout(flush, Math.max(0, EMIT_INTERVAL_MS - (Date.now() - lastEmit)));
		},
		flushNow() {
			if (emitTimer) clearTimeout(emitTimer);
			flush();
		},
	};
}

function renderCollapsedWorkflowResult(
	details: WorkflowDetails,
	header: string,
	totals: string,
	theme: WorkflowRenderResultArgs[2],
) {
	let text = header;
	for (const agent of details.agents) {
		const context = agentContext(agent);
		text += `\n  ${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)}${
			agent.phase ? theme.fg("dim", ` (${agent.phase})`) : ""
		}${theme.fg("dim", `${context ? ` · ${context}` : ""} · ${formatElapsed(agent.startedAt, agent.finishedAt)}`)}`;
	}
	if (totals) text += `\n  ${theme.fg("dim", `Total: ${totals}`)}`;
	if (details.error) text += `\n  ${theme.fg("error", `Error: ${details.error}`)}`;
	text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	return new Text(text, 0, 0);
}

function renderExpandedWorkflowResult(
	details: WorkflowDetails,
	header: string,
	totals: string,
	theme: WorkflowRenderResultArgs[2],
) {
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	if (details.description) container.addChild(new Text(theme.fg("dim", details.description), 0, 0));
	for (const group of phaseGroups(details)) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", `─── ${group.title} ───`), 0, 0));
		for (const agent of group.agents) {
			const usage = formatUsage(agent.usage, agent.model);
			const context = agentContext(agent);
			let line = `${stateSquare(agent.state, theme)} ${theme.fg("accent", agent.label)} ${theme.fg(
				"dim",
				[context, formatElapsed(agent.startedAt, agent.finishedAt)].filter(Boolean).join(" · "),
			)}`;
			if (usage) line += ` ${theme.fg("dim", usage)}`;
			container.addChild(new Text(line, 0, 0));
			if (agent.error) container.addChild(new Text(`  ${theme.fg("error", agent.error)}`, 0, 0));
			else if (agent.preview) {
				const preview = agent.preview.split("\n").slice(0, 2).join(" ");
				container.addChild(new Text(`  ${theme.fg("dim", preview)}`, 0, 0));
			}
		}
	}
	if (details.error) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("error", `Error: ${details.error}`), 0, 0));
	}
	if (details.result !== undefined) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── result ───"), 0, 0));
		container.addChild(new Markdown(`\`\`\`json\n${resultJson(details.result)}\n\`\`\``, 0, 0, getMarkdownTheme()));
	}
	if (totals) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totals}`), 0, 0));
	}
	return container;
}

function createWorkflowState(): WorkflowState {
	return { activeRuns: new Map(), lastUi: undefined, completedRuns: 0, failedRuns: 0 };
}

function activeDetails(state: WorkflowState) {
	return new Map([...state.activeRuns].map(([runId, run]) => [runId, run.details] as const));
}

function updateIndicator(state: WorkflowState) {
	if (!state.lastUi) return;
	try {
		const running = state.activeRuns.size;
		if (running === 0 && state.completedRuns === 0 && state.failedRuns === 0) {
			registerTransientSegment("workflows", null);
			return;
		}
		const parts = [
			...(running > 0 ? [`${running} running`] : []),
			...(state.completedRuns > 0 ? [`${state.completedRuns} done`] : []),
			...(state.failedRuns > 0 ? [`${state.failedRuns} failed`] : []),
		];
		const bg = state.failedRuns > 0 ? "#e78284" : running > 0 ? "#81c8be" : "#a6d189";
		registerTransientSegment("workflows", { text: parts.join(" · "), bg, fg: "#1e2030" });
	} catch {
		// UI may be unavailable.
	}
}

function recordSettledRun(state: WorkflowState, status: WorkflowDetails["status"]) {
	if (status === "completed") state.completedRuns += 1;
	else state.failedRuns += 1;
}

function registerWorkflowLifecycle(pi: ExtensionAPI, state: WorkflowState) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) state.lastUi = ctx.ui;
		updateIndicator(state);
	});
	pi.on("session_shutdown", async () => {
		const runs = [...state.activeRuns.values()];
		for (const run of runs) run.controller.abort("Session is shutting down");
		await Promise.all(runs.map((run) => run.controller.settle({ abort: true })));
		const completions = runs
			.map((run) => run.completion)
			.filter((completion): completion is Promise<void> => completion !== undefined);
		if (completions.length > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 8_000);
				timer.unref?.();
			});
			await Promise.race([Promise.allSettled(completions), timeout]);
			if (timer) clearTimeout(timer);
		}
		registerTransientSegment("workflows", null);
		state.lastUi = undefined;
	});
}

function registerWorkflowCommand(pi: ExtensionAPI, state: WorkflowState) {
	pi.registerCommand("workflows", {
		description: "List workflow runs (`/workflows <runId>` for one run's detail)",
		handler: async (rawArgs, ctx) => {
			const arg = rawArgs.trim();
			if (ctx.mode === "tui") {
				state.lastUi = ctx.ui;
				await showWorkflowDashboard(ctx, () => activeDetails(state), arg || undefined);
				state.completedRuns = 0;
				state.failedRuns = 0;
				updateIndicator(state);
				return;
			}
			const runs = await listRuns(activeDetails(state), ctx.sessionManager.getSessionId(), sessionWorkflowRunIds(ctx));
			if (runs.length === 0) {
				ctx.ui.notify("No workflow runs yet.", "info");
				return;
			}
			if (arg) {
				const run = runs.find((item) => item.runId === arg || item.runId.endsWith(arg));
				ctx.ui.notify(
					run ? await runDetailText(run, activeDetails(state)) : `No workflow run matching "${arg}".`,
					run ? "info" : "warning",
				);
				return;
			}
			const labels = runs.map(
				(run) => `${run.active ? "* " : "  "}${run.runId}  ${run.status}  ${run.name ?? ""}  ${run.done}/${run.total}`,
			);
			if (!ctx.hasUI) {
				ctx.ui.notify(labels.join("\n"), "info");
				return;
			}
			const choice = await ctx.ui.select("Workflow runs", labels);
			if (!choice) return;
			const run = runs[labels.indexOf(choice)];
			if (run) ctx.ui.notify(await runDetailText(run, activeDetails(state)), "info");
		},
	});
}

async function executeWorkflow({ pi, state, params, signal, onUpdate, ctx }: WorkflowExecutionOptions) {
	let prepared: ReturnType<typeof prepareWorkflowScript>;
	try {
		prepared = prepareWorkflowScript(params.script);
	} catch (error) {
		throw new Error(`Workflow script failed to parse: ${errorText(error)}`);
	}

	let args: unknown;
	if (params.args !== undefined) {
		try {
			args = JSON.parse(params.args);
		} catch {
			args = params.args;
		}
	}

	const meta = prepared.meta;
	const runId = `wf_${randomBytes(6).toString("hex")}`;
	const runDir = path.join(getAgentDir(), "workflows", runId);
	const background = (params.background ?? false) && ctx.hasUI;

	const details: WorkflowDetails = {
		runId,
		sessionId: ctx.sessionManager.getSessionId(),
		...(meta.name === undefined ? {} : { name: meta.name }),
		...(meta.description === undefined ? {} : { description: meta.description }),
		background,
		status: "running",
		startedAt: Date.now(),
		phases: [...meta.phases],
		agents: [],
	};

	const initialWrites = await Promise.allSettled([
		writeFileAtomic(path.join(runDir, "script.js"), params.script),
		...(params.args === undefined ? [] : [writeFileAtomic(path.join(runDir, "args.json"), params.args)]),
		persistWorkflowJson(runDir, details),
	]);
	const initialFailure = initialWrites.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (initialFailure) throw initialFailure.reason;
	const persistence = createWorkflowPersistence(runDir, details);

	// Background runs survive Esc on the parent turn, but all runs are
	// aborted and settled during session shutdown.
	const controller = new RunController(background ? undefined : signal);

	// Each concurrent child gets its own extension runtime. All children use
	// the parent cwd and live trust decision.
	const projectTrusted = ctx.isProjectTrusted();
	const getResources = (structured: boolean) =>
		createWorkflowResources(ctx.cwd, structured ? "structured" : "plain", projectTrusted);

	const { emit, flushNow } = createProgressEmitter({ background, details, persistence, onUpdate });

	const phaseFn = (title: unknown) => {
		const text = String(title);
		details.currentPhase = text;
		if (!details.phases.some((p) => p.title === text)) details.phases.push({ title: text });
		emit();
	};

	let agentCounter = 0;
	const agentFn = async (
		promptValue: unknown,
		optsValue: unknown = {},
		invocationSignal?: AbortSignal,
	): Promise<ScriptAgentResult> => {
		const index = ++agentCounter;
		const opts: AgentCallOptions = optsValue && typeof optsValue === "object" ? (optsValue as AgentCallOptions) : {};
		const label =
			typeof opts.label === "string" && opts.label.trim() ? opts.label.trim().slice(0, 160) : `agent-${index}`;

		const record: AgentRecord = {
			index,
			label,
			...(typeof opts.phase === "string"
				? { phase: opts.phase.slice(0, 160) }
				: details.currentPhase === undefined
					? {}
					: { phase: details.currentPhase }),
			state: "running",
			model: ctx.model?.id,
			contextWindow: ctx.model?.contextWindow,
			startedAt: Date.now(),
			preview: "",
			usage: emptyUsage(),
			transcript: [],
		};
		details.agents.push(record);
		persistence.checkpoint({ immediate: true });
		emit(false);

		const fail = (error: string): ScriptAgentResult => {
			record.state = "error";
			record.error = error;
			record.finishedAt = Date.now();
			emit();
			return { ok: false, output: "", error };
		};

		if (typeof promptValue !== "string" || !promptValue.trim()) {
			return fail("agent() requires a non-empty prompt string");
		}
		const prompt = buildWorkflowAgentPrompt(promptValue);
		if (controller.signal.aborted) return fail("Workflow was aborted before this agent started");

		return controller
			.schedule(async (runSignal) => {
				// Model/provider resolution: default to the parent session's model.
				let model: WorkflowModel | undefined = ctx.model;
				if (opts.model !== undefined || opts.provider !== undefined) {
					const modelOpt = typeof opts.model === "string" ? opts.model : undefined;
					const providerOpt = typeof opts.provider === "string" ? opts.provider : undefined;
					if (!modelOpt) return fail(`agent "${label}": \`provider\` requires \`model\` as well`);
					let resolved: WorkflowModel | undefined;
					if (providerOpt) {
						resolved = ctx.modelRegistry.find(providerOpt, modelOpt);
					} else {
						const slash = modelOpt.indexOf("/");
						if (slash > 0) {
							resolved = ctx.modelRegistry.find(modelOpt.slice(0, slash), modelOpt.slice(slash + 1));
						}
						resolved ??= ctx.modelRegistry.getAll().find((m) => m.id === modelOpt);
					}
					if (!resolved) {
						const requested = providerOpt ? `${providerOpt}/${modelOpt}` : modelOpt;
						return fail(`agent "${label}": unknown model "${requested}" (use provider/id)`);
					}
					model = resolved;
				}
				record.model = model?.id;
				record.contextWindow = model?.contextWindow;
				emit();

				// Effort → thinking level; default inherits the parent session.
				let thinkingLevel: ThinkingLevel = pi.getThinkingLevel();
				if (opts.effort !== undefined) {
					if (typeof opts.effort !== "string") {
						return fail(`agent "${label}": effort must be a string`);
					}
					const effort = opts.effort;
					if (!(THINKING_LEVELS as readonly string[]).includes(effort)) {
						return fail(`agent "${label}": invalid effort "${effort}" (use ${THINKING_LEVELS.join("|")})`);
					}
					thinkingLevel = effort as ThinkingLevel;
				}

				const resources = await getResources(opts.schema !== undefined);
				const outcome = await runAgent({
					prompt,
					schema: opts.schema,
					...(model === undefined ? {} : { model }),
					thinkingLevel,
					cwd: ctx.cwd,
					loader: resources.loader,
					settingsManager: resources.settingsManager,
					modelRegistry: ctx.modelRegistry,
					signal: runSignal,
					onProgress: (progress) => {
						record.preview = progress.preview.slice(0, PREVIEW_LENGTH);
						record.usage = progress.usage;
						record.model = progress.model ?? record.model;
						record.contextWindow = progress.contextWindow ?? record.contextWindow;
						record.transcript = progress.transcript;
						emit();
					},
				});

				return applyAgentOutcome(record, outcome, emit);
			}, invocationSignal)
			.catch((error) => fail(errorText(error)));
	};

	const runScript = async () => {
		let status: WorkflowDetails["status"] = "completed";
		try {
			details.result = await runWorkflowSandbox({
				source: prepared.source,
				args,
				cwd: ctx.cwd,
				signal: controller.signal,
				onAgent: agentFn,
				onPhase: phaseFn,
			});
		} catch (error) {
			details.error = errorText(error);
			status = controller.signal.aborted ? "aborted" : "failed";
			controller.abort("Workflow script failed");
		}

		const settled = await controller.settle({
			abort: status !== "completed",
		});
		if (!settled) {
			status = "failed";
			details.error = details.error
				? `${details.error}; agent shutdown deadline exceeded`
				: "Agent shutdown deadline exceeded";
		}
		for (const record of details.agents) {
			if (record.state !== "running") continue;
			record.state = "error";
			record.error = record.error ?? "Agent did not settle before run cleanup";
			record.finishedAt = Date.now();
		}
		details.status = status;
		details.finishedAt = Date.now();
		try {
			await persistence.flush();
		} catch (error) {
			details.status = "failed";
			details.error = `Artifact persistence failed: ${errorText(error)}`;
			throw new Error(details.error);
		} finally {
			flushNow();
		}
	};

	return completeWorkflowRun({
		pi,
		state,
		ctx,
		runId,
		runDir,
		background,
		details,
		controller,
		runScript,
	});
}

async function completeWorkflowRun({
	pi,
	state,
	ctx,
	runId,
	runDir,
	background,
	details,
	controller,
	runScript,
}: {
	pi: ExtensionAPI;
	state: WorkflowState;
	ctx: ExtensionContext;
	runId: string;
	runDir: string;
	background: boolean;
	details: WorkflowDetails;
	controller: RunController;
	runScript: () => Promise<void>;
}) {
	const activeRun: ActiveWorkflowRun = { details, controller };
	state.activeRuns.set(runId, activeRun);
	const completion = runScript();
	activeRun.completion = completion;
	if (ctx.hasUI) state.lastUi = ctx.ui;
	updateIndicator(state);
	if (background) {
		void completion
			.catch((error) => {
				details.status = "failed";
				details.finishedAt = Date.now();
				details.error = details.error ?? errorText(error);
			})
			.finally(() => {
				state.activeRuns.delete(runId);
				recordSettledRun(state, details.status);
				updateIndicator(state);
				try {
					pi.sendUserMessage(
						buildBackgroundWorkflowFollowUp({
							runId,
							status: details.status,
							result: buildWorkflowResultMessage(details, runDir),
						}),
						{ deliverAs: "followUp" },
					);
				} catch {
					// Session may be shutting down.
				}
			});
		return {
			content: [
				{
					type: "text" as const,
					text: buildBackgroundWorkflowLaunchResult({
						runId,
						...(details.name === undefined ? {} : { name: details.name }),
						runDir,
					}),
				},
			],
			details: compactToolDetails(details),
		};
	}
	try {
		await completion;
	} finally {
		state.activeRuns.delete(runId);
		recordSettledRun(state, details.status);
		updateIndicator(state);
	}
	if (details.status !== "completed") throw new Error(buildWorkflowResultMessage(details, runDir));
	return {
		content: [{ type: "text" as const, text: buildWorkflowResultMessage(details, runDir) }],
		details: compactToolDetails(details),
	};
}

function registerWorkflowTool(pi: ExtensionAPI, state: WorkflowState) {
	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: WORKFLOW_TOOL_DESCRIPTION,
		promptSnippet: WORKFLOW_PROMPT_SNIPPET,
		promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
		parameters: WorkflowParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeWorkflow({ pi, state, params, signal, onUpdate, ctx });
		},

		renderCall(args: Partial<WorkflowInput>, theme) {
			const meta = typeof args.script === "string" ? extractMeta(args.script) : { phases: [] };
			let text =
				theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", (meta as WorkflowMeta).name ?? "(script)");
			if (args.background) text += theme.fg("dim", " (background)");
			const description = (meta as WorkflowMeta).description;
			if (description) text += `\n  ${theme.fg("dim", description)}`;
			for (const phase of meta.phases.slice(0, 8)) {
				text += `\n  ${theme.fg("dim", SQUARE)} ${theme.fg("accent", phase.title)}${
					phase.detail ? theme.fg("dim", ` — ${phase.detail}`) : ""
				}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as WorkflowDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const { done, failed } = countStates(details);
			const settled = done + failed;
			const elapsed = formatElapsed(details.startedAt, details.finishedAt);
			let header =
				`${theme.fg(statusColor(details.status), SQUARE)} ${theme.fg("toolTitle", theme.bold("workflow "))}` +
				`${theme.fg("accent", details.name ?? details.runId)} ` +
				theme.fg("dim", `${settled}/${details.agents.length} agents · ${elapsed} · `) +
				theme.fg(statusColor(details.status), statusWord(details.status));
			if (failed) header += theme.fg("error", ` · ${failed} failed`);
			if (details.background) header += theme.fg("dim", " (background)");
			if (details.status === "running" && details.currentPhase) {
				header += theme.fg("muted", ` · ${details.currentPhase}`);
			}
			const totals = formatUsage(aggregateUsage(details.agents));

			return expanded
				? renderExpandedWorkflowResult(details, header, totals, theme)
				: renderCollapsedWorkflowResult(details, header, totals, theme);
		},
	});
}

export default function workflows(pi: ExtensionAPI) {
	const state = createWorkflowState();
	registerWorkflowLifecycle(pi, state);
	registerWorkflowCommand(pi, state);
	registerWorkflowTool(pi, state);
}
