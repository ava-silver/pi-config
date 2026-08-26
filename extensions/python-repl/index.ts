import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	highlightCode,
	truncateTail,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PythonRepl, type ExecutionResult } from "./runtime.ts";

function formatExecution(result: ExecutionResult): string {
	return [
		result.stdout ? `stdout:\n${result.stdout.trimEnd()}` : undefined,
		result.stderr ? `stderr:\n${result.stderr.trimEnd()}` : undefined,
		result.result !== null ? `result:\n${result.result}` : undefined,
		result.error ? `error:\n${result.error.trimEnd()}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	const repl = new PythonRepl();
	let artifactCounter = 0;

	const truncateOutput = async (output: string): Promise<string> => {
		const content = output || "(no output)";
		const truncation = truncateTail(content, {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		if (!truncation.truncated) return truncation.content;

		const environmentPath = repl.environmentPath;
		if (!environmentPath) return truncation.content;
		const artifactPath = path.join(environmentPath, `output-${++artifactCounter}.txt`);
		await withFileMutationQueue(artifactPath, () => fs.writeFile(artifactPath, content, { mode: 0o600 }));
		const notice = `\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Full output: ${artifactPath}]`;
		const reserved = Buffer.byteLength(notice);
		const bounded = truncateTail(content, {
			maxBytes: DEFAULT_MAX_BYTES - reserved,
			maxLines: DEFAULT_MAX_LINES - 2,
		});
		return bounded.content + notice;
	};

	pi.registerTool({
		name: "python_repl",
		label: "Python REPL",
		description: `Execute Python in a stateful, session-scoped REPL backed by a temporary virtual environment. Variables and imports persist across calls. The final expression is returned like an interactive REPL. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Execute Python code in a stateful temporary virtual environment",
		promptGuidelines: [
			"Use python_repl for stateful Python calculations, data exploration, and Python library APIs.",
			"Use python_repl_install before python_repl when a required third-party package is unavailable.",
		],
		parameters: Type.Object({
			code: Type.String({ description: "Python code to execute. Variables and imports persist across calls." }),
		}),
		renderCall(args, theme) {
			const code = args.code ?? "";
			const title = theme.fg("toolTitle", theme.bold("python_repl"));
			return new Text(code ? `${title}\n${highlightCode(code, "python").join("\n")}` : title, 0, 0);
		},
		async execute(_id, params, signal) {
			const result = await repl.execute(params.code, signal);
			const output = await truncateOutput(formatExecution(result));
			if (result.error) throw new Error(output);
			return {
				content: [{ type: "text", text: output }],
				details: { environmentPath: repl.environmentPath },
			};
		},
	});

	pi.registerTool({
		name: "python_repl_install",
		label: "Install Python Packages",
		description:
			"Install arbitrary PyPI packages into the current Python REPL's temporary virtual environment. Package names may use standard pip requirement syntax.",
		parameters: Type.Object({
			packages: Type.Array(Type.String(), {
				description: 'Packages to install, for example ["pandas", "requests==2.32.3"]',
				minItems: 1,
				maxItems: 32,
			}),
		}),
		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("python_repl_install"));
			const packages = args.packages?.map((value) => theme.fg("accent", value)).join(", ");
			return new Text(packages ? `${title} ${packages}` : title, 0, 0);
		},
		async execute(_id, params, signal) {
			const packages = params.packages.map((value) => value.trim());
			if (packages.some((value) => value.length === 0)) throw new Error("Package names must not be empty.");
			const result = await repl.install(packages, signal);
			const output = await truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n") || "Installed.");
			return {
				content: [{ type: "text", text: output }],
				details: { packages, environmentPath: repl.environmentPath },
			};
		},
	});

	pi.registerTool({
		name: "python_repl_clear",
		label: "Clear Python REPL",
		description:
			"Clear all variables and imports from the stateful Python REPL. Installed packages remain available in its temporary virtual environment.",
		parameters: Type.Object({}),
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("python_repl_clear")), 0, 0);
		},
		async execute(_id, _params, signal) {
			await repl.clear(signal);
			return {
				content: [{ type: "text", text: "Python REPL state cleared. Installed packages remain available." }],
				details: { environmentPath: repl.environmentPath },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		await repl.close();
	});
}
