/**
 * /workflows dashboard: a full-screen overlay with a run list and a per-run
 * detail view (phases sidebar + agents panel), modeled after:
 *
 *   name                                             5/5 agents · 31m18s · done
 *   description
 *   ╭ Phases ────────────╮ ╭ Gather · 3 agents ──────────────────────────────╮
 *   │ ❯ ■ Gather     3/3 │ │ ■ CodeRabbit feedback   gpt-5 · 7%/372k  5m37s│
 *   │   ■ Verify     1/1 │ │ ■ Other bot feedback    gpt-5 · 9%/372k  4m43s│
 *   ╰────────────────────╯ ╰─────────────────────────────────────────────────╯
 *   up/down select · esc back · s save report
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import {
	agentContext,
	countStates,
	formatElapsed,
	formatUsage,
	aggregateUsage,
	phaseGroups,
	resultJson,
	shortenHome,
	stateSquare,
	statusColor,
	statusWord,
	SQUARE,
	type Theme,
	type AgentRecord,
	type PhaseGroup,
	type TranscriptEntry,
	type WorkflowDetails,
} from "./model.ts";

const NOTICE_TTL_MS = 4000;
const MIN_HEIGHT = 10;
const TRANSCRIPT_SCROLL_STEP = 20;

function wrapSelection(index: number, delta: number, length: number): number {
	if (length === 0) return 0;
	return (index + delta + length) % length;
}

export interface RunEntry {
	runId: string;
	details: WorkflowDetails;
	live: boolean;
}

function runsDir(): string {
	return path.join(getAgentDir(), "workflows");
}

export function createHistoricalRunCache(load: typeof loadRunEntries = loadRunEntries): {
	get(
		active: Map<string, WorkflowDetails>,
		sessionId: string,
		referencedRunIds: ReadonlySet<string>,
		force?: boolean,
	): Promise<RunEntry[]>;
} {
	let activeSignature = "";
	let entries: RunEntry[] = [];
	return {
		async get(active, sessionId, referencedRunIds, force = false) {
			const signature = [...active.keys()].sort().join(",");
			if (force || signature !== activeSignature) {
				entries = await load(active, sessionId, referencedRunIds);
				activeSignature = signature;
			}
			return entries;
		},
	};
}

function normalizeTranscript(value: unknown): TranscriptEntry[] {
	if (!Array.isArray(value)) return [];
	const transcript: TranscriptEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const entry = item as Record<string, unknown>;
		if (
			entry.role !== "user" &&
			entry.role !== "assistant" &&
			entry.role !== "thinking" &&
			entry.role !== "tool" &&
			entry.role !== "toolResult"
		) {
			continue;
		}
		if (typeof entry.text !== "string") continue;
		transcript.push({
			role: entry.role,
			text: entry.text,
			...(typeof entry.name === "string" ? { name: entry.name } : {}),
			isError: entry.isError === true,
			...(typeof entry.timestamp === "number" ? { timestamp: entry.timestamp } : {}),
		});
	}
	return transcript;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function optionalString(key: string, record: Record<string, unknown>, fallback?: Record<string, unknown>): object {
	const value = stringValue(record, key) ?? (fallback && stringValue(fallback, key));
	return value === undefined ? {} : { [key]: value };
}

function agentState(value: unknown): AgentRecord["state"] {
	if (value === "error" || value === "failed") return "error";
	return value === "running" ? "running" : "done";
}

function normalizeAgent(value: unknown, index: number, startedAt: number): AgentRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const agent = value as Record<string, unknown>;
	const contextWindow = numberValue(agent, "contextWindow");
	const finishedAt = numberValue(agent, "finishedAt");
	const error = stringValue(agent, "error");
	return {
		index: numberValue(agent, "index") ?? index,
		label: stringValue(agent, "label") ?? `agent-${index}`,
		...optionalString("phase", agent),
		state: agentState(agent.state),
		...optionalString("model", agent),
		...(contextWindow && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
		startedAt: numberValue(agent, "startedAt") ?? startedAt,
		...(finishedAt === undefined ? {} : { finishedAt }),
		...(error !== undefined && error !== "[undefined]" ? { error } : {}),
		preview: stringValue(agent, "preview") ?? "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
			...(agent.usage && typeof agent.usage === "object" ? agent.usage : {}),
		},
		transcript: normalizeTranscript(agent.transcript),
	};
}

function normalizePhase(value: unknown): WorkflowDetails["phases"][number] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const phase = value as Record<string, unknown>;
	const title = stringValue(phase, "title");
	return title === undefined ? undefined : { title, ...optionalString("detail", phase) };
}

function normalizedStatus(value: unknown): WorkflowDetails["status"] {
	return value === "running" || value === "failed" || value === "aborted" ? value : "completed";
}

/** Leniently normalize a workflow.json (including runs from older tooling). */
function normalizeDetails(runId: string, raw: unknown): WorkflowDetails | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const meta = record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : {};
	const startedAt = numberValue(record, "startedAt") ?? 0;
	const agents = (Array.isArray(record.agents) ? record.agents : []).reduce<AgentRecord[]>((normalized, agent) => {
		const result = normalizeAgent(agent, normalized.length + 1, startedAt);
		if (result) normalized.push(result);
		return normalized;
	}, []);
	const rawPhases = Array.isArray(record.phases) ? record.phases : Array.isArray(meta.phases) ? meta.phases : [];
	const phases = rawPhases
		.map(normalizePhase)
		.filter((phase): phase is WorkflowDetails["phases"][number] => phase !== undefined);
	const result = record.result;
	const finishedAt = numberValue(record, "finishedAt");

	return {
		runId,
		...optionalString("sessionId", record),
		...optionalString("name", record, meta),
		...optionalString("description", record, meta),
		background: record.background === true,
		status: normalizedStatus(record.status),
		startedAt,
		...(finishedAt === undefined ? {} : { finishedAt }),
		phases,
		...optionalString("currentPhase", record),
		agents,
		...(result === undefined ? {} : { result }),
		...optionalString("resultArtifact", record),
		...optionalString("transcriptArtifact", record),
		...optionalString("error", record),
	};
}

export function sessionWorkflowRunIds(ctx: ExtensionContext): Set<string> {
	const runIds = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "workflow") {
			continue;
		}
		const details = entry.message.details;
		if (!details || typeof details !== "object") continue;
		const runId = (details as Record<string, unknown>).runId;
		if (typeof runId === "string") runIds.add(runId);
	}
	return runIds;
}

async function restoreResult(details: WorkflowDetails, runDir: string): Promise<void> {
	if (!details.resultArtifact) return;
	try {
		details.result = JSON.parse(await fs.readFile(path.join(runDir, path.basename(details.resultArtifact)), "utf8"));
	} catch {
		// Keep the compact compatibility marker from workflow.json.
	}
}

async function restoreTranscripts(details: WorkflowDetails, runDir: string): Promise<void> {
	if (!details.transcriptArtifact) return;
	try {
		const transcripts = JSON.parse(
			await fs.readFile(path.join(runDir, path.basename(details.transcriptArtifact)), "utf8"),
		) as Record<string, unknown>;
		for (const agent of details.agents) agent.transcript = normalizeTranscript(transcripts[String(agent.index)]);
	} catch {
		// Older or partially written artifacts simply lack transcripts.
	}
}

function recoverStaleRun(details: WorkflowDetails): void {
	if (details.status !== "running") return;
	details.status = "aborted";
	details.finishedAt = details.finishedAt ?? Date.now();
	details.error = details.error ?? "Recovered stale run that was not active";
	for (const agent of details.agents) {
		if (agent.state !== "running") continue;
		agent.state = "error";
		agent.error = agent.error ?? "Run ended before this agent settled";
		agent.finishedAt = details.finishedAt;
	}
}

async function loadHistoricalRun(
	active: Map<string, WorkflowDetails>,
	sessionId: string,
	referencedRunIds: ReadonlySet<string>,
	runId: string,
): Promise<RunEntry | undefined> {
	const live = active.get(runId);
	if (live) return { runId, details: live, live: true };
	try {
		const raw = JSON.parse(await fs.readFile(path.join(runsDir(), runId, "workflow.json"), "utf8"));
		const details = normalizeDetails(runId, raw);
		if (!details || (details.sessionId !== sessionId && !referencedRunIds.has(runId))) return undefined;
		const runDir = path.join(runsDir(), runId);
		await restoreResult(details, runDir);
		await restoreTranscripts(details, runDir);
		recoverStaleRun(details);
		return { runId, details, live: false };
	} catch {
		return undefined;
	}
}

export async function loadRunEntries(
	active: Map<string, WorkflowDetails>,
	sessionId: string,
	referencedRunIds: ReadonlySet<string>,
): Promise<RunEntry[]> {
	const names = (await fs.readdir(runsDir()).catch(() => [] as string[])).filter((name) => name.startsWith("wf_"));
	const entries: RunEntry[] = [];
	for (const runId of names) {
		const entry = await loadHistoricalRun(active, sessionId, referencedRunIds, runId);
		if (entry) entries.push(entry);
	}
	return entries.sort((a, b) => b.details.startedAt - a.details.startedAt);
}

function buildReport(details: WorkflowDetails): string {
	const { done, failed } = countStates(details);
	const lines: string[] = [
		`# Workflow ${details.name ?? details.runId}`,
		"",
		`- Run: ${details.runId}`,
		`- Status: ${statusWord(details.status)}`,
		`- Agents: ${done}/${details.agents.length} ok${failed ? `, ${failed} failed` : ""}`,
		`- Elapsed: ${formatElapsed(details.startedAt, details.finishedAt)}`,
	];
	const totals = formatUsage(aggregateUsage(details.agents));
	if (totals) lines.push(`- Usage: ${totals}`);
	if (details.description) lines.push("", details.description);
	if (details.error) lines.push("", `**Error:** ${details.error}`);

	for (const group of phaseGroups(details, true)) {
		lines.push("", `## ${group.title}`, "");
		if (group.agents.length === 0) {
			lines.push("_no agents_");
			continue;
		}
		for (const agent of group.agents) {
			const status = agent.state === "done" ? "ok" : agent.state === "error" ? "FAILED" : "running";
			const stats = [agent.model, agentContext(agent), formatElapsed(agent.startedAt, agent.finishedAt)]
				.filter(Boolean)
				.join(" · ");
			lines.push(`- **${agent.label}** — ${status}${stats ? ` (${stats})` : ""}`);
			if (agent.error) lines.push(`  - error: ${agent.error}`);
		}
	}

	if (details.result !== undefined) {
		lines.push("", "## Result", "", "```json", resultJson(details.result), "```");
	}
	lines.push("");
	return lines.join("\n");
}

type View = "list" | "detail" | "transcript";
type DetailFocus = "phases" | "agents";

interface WorkflowDashboardOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	getActive: () => Map<string, WorkflowDetails>;
	sessionId: string;
	referencedRunIds: ReadonlySet<string>;
	close: () => void;
	initialRunId?: string | undefined;
}

export class WorkflowDashboard {
	private view: View = "list";
	private entries: RunEntry[] = [];
	private listIndex = 0;
	private phaseIndex = 0;
	private agentIndex = 0;
	private detailFocus: DetailFocus = "phases";
	private transcriptScroll = 0;
	private transcriptRowCount = 0;
	private transcriptViewportSize = 1;
	private current?: RunEntry;
	private notice?: string | undefined;
	private noticeAt = 0;
	private disposed = false;
	private timer: ReturnType<typeof setInterval>;
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private getActive: () => Map<string, WorkflowDetails>;
	private sessionId: string;
	private referencedRunIds: ReadonlySet<string>;
	private close: () => void;
	private historical = createHistoricalRunCache();
	private refreshing = false;
	private initialRunId: string | undefined;

	constructor(options: WorkflowDashboardOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.getActive = options.getActive;
		this.sessionId = options.sessionId;
		this.referencedRunIds = options.referencedRunIds;
		this.close = options.close;
		this.initialRunId = options.initialRunId;
		void this.refresh(true);
		this.timer = setInterval(() => {
			void this.refresh();
		}, 500);
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
	}

	invalidate() {}

	private async refresh(force = false) {
		if (this.disposed || this.refreshing) return;
		const active = this.getActive();
		this.refreshing = true;
		try {
			const historical = await this.historical.get(active, this.sessionId, this.referencedRunIds, force);
			if (this.disposed) return;
			const selected = this.entries[this.listIndex]?.runId;
			const live = [...active].map(([runId, details]) => ({ runId, details, live: true }));
			this.entries = [...live, ...historical.filter((entry) => !active.has(entry.runId))].sort(
				(a, b) => b.details.startedAt - a.details.startedAt,
			);
			if (selected) {
				const index = this.entries.findIndex((entry) => entry.runId === selected);
				if (index >= 0) this.listIndex = index;
			}
			this.listIndex = Math.min(this.listIndex, Math.max(0, this.entries.length - 1));
			if (this.current) {
				const refreshed = this.entries.find((entry) => entry.runId === this.current?.runId);
				if (refreshed) this.current = refreshed;
			}
			if (this.initialRunId) {
				const entry = this.entries.find(
					(item) => item.runId === this.initialRunId || item.runId.endsWith(this.initialRunId!),
				);
				if (entry) {
					this.current = entry;
					this.listIndex = this.entries.indexOf(entry);
					this.view = "detail";
				}
				this.initialRunId = undefined;
			}
			if (this.notice && Date.now() - this.noticeAt > NOTICE_TTL_MS) this.notice = undefined;
			this.tui.requestRender();
		} finally {
			this.refreshing = false;
		}
	}

	private groups(): PhaseGroup[] {
		if (!this.current) return [];
		return phaseGroups(this.current.details, true);
	}

	private selectedGroup(): PhaseGroup | undefined {
		return this.groups()[this.phaseIndex];
	}

	private selectedAgent(): AgentRecord | undefined {
		return this.selectedGroup()?.agents[this.agentIndex];
	}

	private clampAgentIndex() {
		const agents = this.selectedGroup()?.agents ?? [];
		this.agentIndex = Math.min(this.agentIndex, Math.max(0, agents.length - 1));
	}

	private async saveReport() {
		const entry = this.current;
		if (!entry) return;
		const target = path.join(runsDir(), entry.runId, "report.md");
		try {
			await fs.writeFile(target, buildReport(entry.details), { encoding: "utf8", mode: 0o600 });
			this.notice = `saved ${shortenHome(target)}`;
		} catch (error) {
			this.notice = `save failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.noticeAt = Date.now();
		this.tui.requestRender();
	}

	private input(data: string) {
		return {
			data,
			up: this.keybindings.matches(data, "tui.select.up") || data === "k",
			down: this.keybindings.matches(data, "tui.select.down") || data === "j",
			left: this.keybindings.matches(data, "tui.editor.cursorLeft") || data === "h",
			right: this.keybindings.matches(data, "tui.editor.cursorRight") || data === "l",
			confirm: this.keybindings.matches(data, "tui.select.confirm"),
			cancel: this.keybindings.matches(data, "tui.select.cancel"),
		};
	}

	private selectList(input: ReturnType<WorkflowDashboard["input"]>): boolean {
		if (input.up) this.listIndex = wrapSelection(this.listIndex, -1, this.entries.length);
		else if (input.down) this.listIndex = wrapSelection(this.listIndex, 1, this.entries.length);
		else if (input.data === "g") this.listIndex = 0;
		else if (input.data === "G") this.listIndex = Math.max(0, this.entries.length - 1);
		else if (input.confirm) this.openSelectedRun();
		else if (input.cancel) {
			this.close();
			return false;
		}
		return true;
	}

	private openSelectedRun() {
		const entry = this.entries[this.listIndex];
		if (!entry) return;
		this.current = entry;
		this.phaseIndex = 0;
		this.agentIndex = 0;
		this.detailFocus = "phases";
		this.view = "detail";
	}

	private selectPhase(input: ReturnType<WorkflowDashboard["input"]>) {
		const groupCount = this.groups().length;
		if (input.up || input.down) {
			this.phaseIndex = wrapSelection(this.phaseIndex, input.up ? -1 : 1, groupCount);
			this.agentIndex = 0;
		} else if (input.data === "g" || input.data === "G") {
			this.phaseIndex = input.data === "g" ? 0 : Math.max(0, groupCount - 1);
			this.agentIndex = 0;
		} else if (input.right || (input.confirm && (this.selectedGroup()?.agents.length ?? 0) > 0)) {
			this.selectAgents();
		} else if (input.cancel) {
			this.view = "list";
			void this.refresh();
		}
	}

	private selectAgents() {
		if ((this.selectedGroup()?.agents.length ?? 0) === 0) return;
		this.detailFocus = "agents";
		this.clampAgentIndex();
	}

	private selectAgent(input: ReturnType<WorkflowDashboard["input"]>) {
		const agents = this.selectedGroup()?.agents ?? [];
		if (input.up) this.agentIndex = wrapSelection(this.agentIndex, -1, agents.length);
		else if (input.down) this.agentIndex = wrapSelection(this.agentIndex, 1, agents.length);
		else if (input.data === "g") this.agentIndex = 0;
		else if (input.data === "G") this.agentIndex = Math.max(0, agents.length - 1);
		else if (input.left || input.cancel) this.detailFocus = "phases";
		else if (input.confirm && this.selectedAgent()) {
			this.transcriptScroll = 0;
			this.view = "transcript";
		}
	}

	private scrollTranscript(input: ReturnType<WorkflowDashboard["input"]>) {
		const maxScroll = Math.max(0, this.transcriptRowCount - this.transcriptViewportSize);
		const scrollStep = input.data === "j" || input.data === "k" ? TRANSCRIPT_SCROLL_STEP : 1;
		const pageStep = Math.max(1, this.transcriptViewportSize - 2);
		if (input.up) this.transcriptScroll = Math.max(0, this.transcriptScroll - scrollStep);
		else if (input.down) this.transcriptScroll = Math.min(maxScroll, this.transcriptScroll + scrollStep);
		else if (matchesKey(input.data, Key.ctrl("u")))
			this.transcriptScroll = Math.max(0, this.transcriptScroll - pageStep);
		else if (matchesKey(input.data, Key.ctrl("d")))
			this.transcriptScroll = Math.min(maxScroll, this.transcriptScroll + pageStep);
		else if (input.data === "g") this.transcriptScroll = 0;
		else if (input.data === "G") this.transcriptScroll = maxScroll;
		else if (input.cancel || input.left) {
			this.view = "detail";
			this.detailFocus = "agents";
		}
	}

	handleInput(data: string) {
		const input = this.input(data);
		const shouldRender =
			this.view === "list"
				? this.selectList(input)
				: this.view === "detail"
					? this.selectDetail(input)
					: (this.scrollTranscript(input), true);
		if (shouldRender) this.tui.requestRender();
	}

	private selectDetail(input: ReturnType<WorkflowDashboard["input"]>): boolean {
		if (this.detailFocus === "phases") this.selectPhase(input);
		else this.selectAgent(input);
		if (input.data === "s") void this.saveReport();
		return true;
	}

	render(width: number): string[] {
		const height = Math.max(MIN_HEIGHT, this.tui.terminal.rows - 1);
		let lines: string[];
		if (this.view === "transcript" && this.current && this.selectedAgent()) {
			lines = this.renderTranscript(this.current.details, this.selectedAgent()!, width, height);
		} else if (this.view === "detail" && this.current) {
			lines = this.renderDetail(this.current.details, width, height);
		} else {
			lines = this.renderList(width, height);
		}
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	/** Compose `left ... right` within `width`, truncating left when needed. */
	private split(left: string, right: string, width: number): string {
		const rightWidth = visibleWidth(right);
		let text = left;
		if (visibleWidth(text) + rightWidth + 1 > width) {
			text = truncateToWidth(text, Math.max(0, width - rightWidth - 2), "…");
		}
		const pad = Math.max(1, width - visibleWidth(text) - rightWidth);
		return text + " ".repeat(pad) + right;
	}

	/** Bordered panel with a title in the top border, padded to exact height. */
	private panel(title: string, rows: string[], width: number, height: number): string[] {
		const theme = this.theme;
		const inner = Math.max(0, width - 2);
		const border = (s: string) => theme.fg("borderMuted", s);
		const titleText = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
		const dashes = Math.max(0, inner - visibleWidth(titleText) - 1);
		const lines: string[] = [border("╭─") + titleText + border("─".repeat(dashes) + "╮")];
		const bodyHeight = Math.max(0, height - 2);
		for (let i = 0; i < bodyHeight; i++) {
			const row = rows[i] ?? "";
			const clipped = truncateToWidth(row, inner, "…");
			const pad = Math.max(0, inner - visibleWidth(clipped));
			lines.push(border("│") + clipped + " ".repeat(pad) + border("│"));
		}
		lines.push(border("╰" + "─".repeat(inner) + "╯"));
		return lines;
	}

	/** Scroll window keeping `selected` visible. */
	private windowed<T>(items: T[], selected: number, size: number): { items: T[]; offset: number } {
		if (items.length <= size) return { items, offset: 0 };
		const offset = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
		return { items: items.slice(offset, offset + size), offset };
	}

	private keys(binding: Parameters<KeybindingsManager["getKeys"]>[0]) {
		return this.keybindings.getKeys(binding).join("/") || "unbound";
	}

	private hintLine(hint: string, width: number): string {
		const theme = this.theme;
		if (this.notice) return truncateToWidth(theme.fg("accent", ` ${this.notice}`), width);
		return truncateToWidth(theme.fg("dim", ` ${hint}`), width);
	}

	private renderList(width: number, height: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const header = this.split(
			" " + theme.bold(theme.fg("accent", "Workflows")),
			theme.fg("dim", `${this.entries.length} run${this.entries.length === 1 ? "" : "s"} `),
			width,
		);
		lines.push(header);

		const panelHeight = height - 2;
		const bodyHeight = Math.max(0, panelHeight - 2);

		if (this.entries.length === 0) {
			lines.push(...this.panel("Runs", [theme.fg("dim", " no workflow runs yet")], width, panelHeight));
			lines.push(this.hintLine(`${this.keys("tui.select.cancel")} close`, width));
			return lines;
		}

		const { items, offset } = this.windowed(this.entries, this.listIndex, bodyHeight);
		const rows = items.map((entry, i) => {
			const index = offset + i;
			const selected = index === this.listIndex;
			const d = entry.details;
			const marker = selected ? theme.fg("accent", "❯") : " ";
			const name = d.name ?? d.runId;
			const label = selected ? theme.fg("accent", name) : theme.fg("text", name);
			const { done, failed } = countStates(d);
			const settled = done + failed;
			const right =
				theme.fg("dim", `${settled}/${d.agents.length} agents · ${formatElapsed(d.startedAt, d.finishedAt)} · `) +
				theme.fg(statusColor(d.status), statusWord(d.status)) +
				" ";
			const left = ` ${marker} ${statusSquareFor(d, theme)} ${label} ${theme.fg("dim", d.runId)}`;
			return this.split(left, right, width - 2);
		});
		lines.push(...this.panel("Runs", rows, width, panelHeight));
		lines.push(
			this.hintLine(
				`${this.keys("tui.select.up")}/${this.keys("tui.select.down")} select · ${this.keys("tui.select.confirm")} open · ${this.keys("tui.select.cancel")} close`,
				width,
			),
		);
		return lines;
	}

	private renderDetailHeader(details: WorkflowDetails, width: number): string[] {
		const theme = this.theme;
		const { done, failed } = countStates(details);
		const right =
			theme.fg(
				"dim",
				`${done + failed}/${details.agents.length} agents · ${formatElapsed(details.startedAt, details.finishedAt)} · `,
			) +
			theme.fg(statusColor(details.status), statusWord(details.status)) +
			" ";
		const title = this.split(" " + theme.bold(theme.fg("accent", details.name ?? details.runId)), right, width);
		const totals = formatUsage(aggregateUsage(details.agents));
		const subtitle = this.split(
			" " + theme.fg("muted", details.description ?? details.runId),
			totals ? theme.fg("dim", `${totals} `) : " ",
			width,
		);
		return [title, subtitle];
	}

	private phaseRows(groups: PhaseGroup[], bodyHeight: number, sidebarInner: number): string[] {
		const theme = this.theme;
		const phaseWindow = this.windowed(groups, this.phaseIndex, bodyHeight);
		return phaseWindow.items.map((group, visibleIndex) => {
			const selected = phaseWindow.offset + visibleIndex === this.phaseIndex;
			const marker = selected ? theme.fg(this.detailFocus === "phases" ? "accent" : "muted", "❯") : " ";
			const completed = group.agents.filter((agent) => agent.state !== "running").length;
			const title = theme.fg(selected && this.detailFocus === "phases" ? "accent" : "text", group.title);
			const counts = group.agents.length ? `${completed}/${group.agents.length} ` : "- ";
			return this.split(` ${marker} ${groupSquare(group, theme)} ${title}`, theme.fg("dim", counts), sidebarInner);
		});
	}

	private agentRows(
		details: WorkflowDetails,
		selectedGroup: PhaseGroup | undefined,
		bodyHeight: number,
		agentsInner: number,
	): string[] {
		const theme = this.theme;
		const rows = selectedGroup ? this.visibleAgentRows(selectedGroup, bodyHeight, agentsInner) : [];
		if (selectedGroup?.agents.length === 0) rows.push(theme.fg("dim", " no agents in this phase yet"));
		if (details.error) {
			rows.push("");
			rows.push(truncateToWidth(` ${theme.fg("error", `workflow error: ${details.error}`)}`, agentsInner, "…"));
		}
		return rows;
	}

	private visibleAgentRows(group: PhaseGroup, bodyHeight: number, agentsInner: number): string[] {
		const theme = this.theme;
		const maxLabel = Math.max(0, ...group.agents.map((agent) => agent.label.length));
		const agentWindow = this.windowed(group.agents, this.agentIndex, bodyHeight);
		return agentWindow.items.flatMap((agent, visibleIndex) => {
			const selected = agentWindow.offset + visibleIndex === this.agentIndex;
			const active = selected && this.detailFocus === "agents";
			const marker = active ? theme.fg("accent", "❯") : " ";
			const label = theme.fg(active ? "accent" : "text", agent.label.padEnd(Math.min(maxLabel, 40)));
			const stats = theme.fg("dim", [agent.model, agentContext(agent)].filter(Boolean).join(" · "));
			const left = ` ${marker} ${stateSquare(agent.state, theme)} ${label}  ${stats}`;
			const right = theme.fg("dim", `${formatElapsed(agent.startedAt, agent.finishedAt)} `);
			const row = this.split(left, right, agentsInner);
			return agent.error ? [row, truncateToWidth(`       ${theme.fg("error", agent.error)}`, agentsInner, "…")] : [row];
		});
	}

	private detailHint(): string {
		return this.detailFocus === "phases"
			? `j/k select phase · l/${this.keys("tui.editor.cursorRight")}/${this.keys("tui.select.confirm")} agents · ${this.keys("tui.select.cancel")} back · s save report`
			: `j/k select agent · h/${this.keys("tui.editor.cursorLeft")}/${this.keys("tui.select.cancel")} phases · ${this.keys("tui.select.confirm")} transcript · s save report`;
	}

	private renderDetail(details: WorkflowDetails, width: number, height: number): string[] {
		const groups = this.groups();
		this.phaseIndex = Math.min(this.phaseIndex, Math.max(0, groups.length - 1));
		this.clampAgentIndex();
		const selectedGroup = groups[this.phaseIndex];
		const panelHeight = height - 3;
		const bodyHeight = Math.max(0, panelHeight - 2);
		const maxTitle = Math.max(8, ...groups.map((group) => group.title.length));
		const sidebarWidth = Math.min(Math.max(maxTitle + 12, 20), Math.floor(width / 3));
		const agentsWidth = width - sidebarWidth - 1;
		const phaseRows = this.phaseRows(groups, bodyHeight, sidebarWidth - 2);
		const agentRows = this.agentRows(details, selectedGroup, bodyHeight, agentsWidth - 2);
		const agentCount = selectedGroup?.agents.length ?? 0;
		const agentsTitle = selectedGroup
			? `${selectedGroup.title} · ${agentCount} agent${agentCount === 1 ? "" : "s"}`
			: "Agents";
		const leftPanel = this.panel("Phases", phaseRows, sidebarWidth, panelHeight);
		const rightPanel = this.panel(agentsTitle, agentRows, agentsWidth, panelHeight);
		const panels = leftPanel.map((line, index) => `${line} ${rightPanel[index] ?? ""}`);
		return [...this.renderDetailHeader(details, width), ...panels, this.hintLine(this.detailHint(), width)];
	}

	private transcriptRows(agent: AgentRecord, width: number): string[] {
		const theme = this.theme;
		const rows: string[] = [];
		if (agent.transcript.length === 0) {
			return [theme.fg("dim", " transcript unavailable (this run predates transcript capture)")];
		}

		for (const entry of agent.transcript) {
			const label = transcriptLabel(entry);
			const color = transcriptColor(entry);
			rows.push(` ${theme.fg(color, SQUARE)} ${theme.bold(theme.fg(color, label))}`);
			const contentWidth = Math.max(8, width - 4);
			const styled = theme.fg(entry.role === "thinking" ? "dim" : entry.isError ? "error" : "text", entry.text);
			for (const line of wrapTextWithAnsi(styled, contentWidth)) {
				rows.push(`   ${line}`);
			}
			rows.push("");
		}
		return rows;
	}

	private renderTranscript(details: WorkflowDetails, agent: AgentRecord, width: number, height: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const right = theme.fg(
			"dim",
			[agent.model, agentContext(agent), formatElapsed(agent.startedAt, agent.finishedAt)].filter(Boolean).join(" · ") +
				" ",
		);
		lines.push(
			this.split(` ${stateSquare(agent.state, theme)} ${theme.bold(theme.fg("accent", agent.label))}`, right, width),
		);
		lines.push(
			this.split(
				` ${theme.fg("muted", `${details.name ?? details.runId} · ${agent.phase ?? "unphased"}`)}`,
				theme.fg("dim", `${agent.transcript.length} entries `),
				width,
			),
		);

		const panelHeight = height - 3;
		const bodyHeight = Math.max(1, panelHeight - 2);
		const rows = this.transcriptRows(agent, width - 2);
		this.transcriptRowCount = rows.length;
		this.transcriptViewportSize = bodyHeight;
		const maxScroll = Math.max(0, rows.length - bodyHeight);
		this.transcriptScroll = Math.min(this.transcriptScroll, maxScroll);
		const visible = rows.slice(this.transcriptScroll, this.transcriptScroll + bodyHeight);
		const position =
			rows.length > bodyHeight
				? `Transcript · ${this.transcriptScroll + 1}-${Math.min(rows.length, this.transcriptScroll + bodyHeight)}/${rows.length}`
				: "Transcript";
		lines.push(...this.panel(position, visible, width, panelHeight));
		lines.push(this.hintLine("j/k scroll · ctrl-u/d page · g/G top/bottom · h/left/esc back", width));
		return lines;
	}
}

function transcriptLabel(entry: TranscriptEntry): string {
	if (entry.role === "user") return "USER";
	if (entry.role === "assistant") return "ASSISTANT";
	if (entry.role === "thinking") return "THINKING";
	if (entry.role === "tool") return `TOOL ${entry.name ?? "unknown"}`;
	return `RESULT ${entry.name ?? "unknown"}`;
}

function transcriptColor(entry: TranscriptEntry): "accent" | "success" | "dim" | "warning" | "error" | "muted" {
	if (entry.isError) return "error";
	if (entry.role === "user") return "accent";
	if (entry.role === "assistant") return "success";
	if (entry.role === "thinking") return "dim";
	if (entry.role === "tool") return "warning";
	return "muted";
}

function statusSquareFor(details: WorkflowDetails, theme: Theme): string {
	return theme.fg(statusColor(details.status), SQUARE);
}

function groupSquare(group: PhaseGroup, theme: Theme): string {
	if (group.agents.length === 0) return theme.fg("dim", SQUARE);
	if (group.agents.some((a) => a.state === "running")) return theme.fg("warning", SQUARE);
	if (group.agents.some((a) => a.state === "error")) return theme.fg("error", SQUARE);
	return theme.fg("success", SQUARE);
}

/** Open the dashboard as a full-screen overlay. */
export async function showWorkflowDashboard(
	ctx: ExtensionContext,
	getActive: () => Map<string, WorkflowDetails>,
	initialRunId?: string,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => {
			const dashboard: WorkflowDashboard = new WorkflowDashboard({
				tui,
				theme,
				keybindings,
				getActive,
				sessionId: ctx.sessionManager.getSessionId(),
				referencedRunIds: sessionWorkflowRunIds(ctx),
				close: () => {
					dashboard.dispose();
					done(undefined);
				},
				initialRunId,
			});
			return dashboard;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
		},
	);
}
