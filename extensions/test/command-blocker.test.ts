import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import commandBlocker, {
	basename,
	classifyGhPrMerge,
	containsGhApiMerge,
	findBlockedCommand,
	findExecutable,
	shellCommands,
	shellWords,
	type BlockRule,
} from "../command-blocker.ts";

const BAZEL_RULE: BlockRule = {
	commands: ["bzl", "bazel"],
	reason: "Bazel/bzl builds are extremely slow and should only run in CI. Use `go` commands instead.",
};

const ctx = { cwd: process.cwd() } as ExtensionContext;

test("blocks bazel build", async () => {
	assert.equal(await findBlockedCommand("bazel build //src:lib", [BAZEL_RULE], ctx), BAZEL_RULE.reason);
});

test("blocks bzl test", async () => {
	assert.equal(await findBlockedCommand("bzl test //src:lib", [BAZEL_RULE], ctx), BAZEL_RULE.reason);
});

test("blocks bazel behind rtk wrapper", async () => {
	assert.equal(await findBlockedCommand("rtk bazel build //src:lib", [BAZEL_RULE], ctx), BAZEL_RULE.reason);
});

test("blocks bazel behind sudo wrapper", async () => {
	assert.equal(await findBlockedCommand("sudo bazel build //src:lib", [BAZEL_RULE], ctx), BAZEL_RULE.reason);
});

test("blocks bazel behind env wrapper with assignments", async () => {
	assert.equal(await findBlockedCommand("env GOOS=linux bazel build //src:lib", [BAZEL_RULE], ctx), BAZEL_RULE.reason);
});

test("blocks bazel by basename", async () => {
	assert.equal(await findBlockedCommand("/usr/local/bin/bazel build //src:lib", [BAZEL_RULE], ctx), BAZEL_RULE.reason);
});

test("blocks bazel in a compound command", async () => {
	assert.equal(await findBlockedCommand("echo start; bazel build //src:lib", [BAZEL_RULE], ctx), BAZEL_RULE.reason);
});

test("does not block go commands", async () => {
	assert.equal(await findBlockedCommand("go build ./...", [BAZEL_RULE], ctx), undefined);
	assert.equal(await findBlockedCommand("go test ./...", [BAZEL_RULE], ctx), undefined);
	assert.equal(await findBlockedCommand("go vet ./...", [BAZEL_RULE], ctx), undefined);
});

test("does not block echo mentioning bazel", async () => {
	assert.equal(await findBlockedCommand("echo 'do not run bazel'", [BAZEL_RULE], ctx), undefined);
});

test("returns undefined for empty rules", async () => {
	assert.equal(await findBlockedCommand("bazel build", [], ctx), undefined);
});

test("check function can allow a command", async () => {
	const rule: BlockRule = {
		commands: ["gh"],
		check: async () => undefined,
	};
	assert.equal(await findBlockedCommand("gh pr view 123", [rule], ctx), undefined);
});

test("check function can block with a dynamic reason", async () => {
	const rule: BlockRule = {
		commands: ["gh"],
		check: async () => "blocked by dynamic check",
	};
	assert.equal(await findBlockedCommand("gh pr merge", [rule], ctx), "blocked by dynamic check");
});

test("check function receives the full command string", async () => {
	let received: string | undefined;
	const rule: BlockRule = {
		commands: ["gh"],
		check: async (command) => {
			received = command;
			return undefined;
		},
	};
	await findBlockedCommand("echo a; gh pr merge && echo done", [rule], ctx);
	assert.equal(received, "echo a; gh pr merge && echo done");
});

test("first matching rule wins", async () => {
	const rule1: BlockRule = { commands: ["bazel"], reason: "first" };
	const rule2: BlockRule = { commands: ["bazel"], reason: "second" };
	assert.equal(await findBlockedCommand("bazel build", [rule1, rule2], ctx), "first");
});

test("non-matching rules are skipped", async () => {
	const rule1: BlockRule = { commands: ["go"], reason: "go blocked" };
	const rule2: BlockRule = { commands: ["bazel"], reason: "bazel blocked" };
	assert.equal(await findBlockedCommand("bazel build", [rule1, rule2], ctx), "bazel blocked");
	assert.equal(await findBlockedCommand("go build", [rule1, rule2], ctx), "go blocked");
});

// --- Extension integration tests ---

function createExtensionHandler(): (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | void> {
	let handler: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void>) | undefined;
	commandBlocker({
		on(event: string, callback: unknown) {
			if (event === "tool_call") handler = callback as typeof handler;
		},
	} as ExtensionAPI);
	assert.ok(handler, "tool_call handler should be registered");
	return handler;
}

test("extension blocks bazel via bash tool", async () => {
	const handler = createExtensionHandler();
	const result = await handler(
		{
			type: "tool_call",
			toolCallId: "test",
			toolName: "bash",
			input: { command: "bazel build //src:lib" },
		} as ToolCallEvent,
		ctx,
	);
	assert.equal(result?.block, true);
	assert.ok(typeof result?.reason === "string" && /bazel/i.test(result.reason));
});

test("extension allows go build via bash tool", async () => {
	const handler = createExtensionHandler();
	const result = await handler(
		{ type: "tool_call", toolCallId: "test", toolName: "bash", input: { command: "go build ./..." } } as ToolCallEvent,
		ctx,
	);
	assert.equal(result, undefined);
});

test("extension blocks bazel via background_shell_run", async () => {
	const handler = createExtensionHandler();
	const result = await handler(
		{
			type: "tool_call",
			toolCallId: "test",
			toolName: "background_shell_run",
			input: { command: "bzl test //src:lib" },
		} as ToolCallEvent,
		ctx,
	);
	assert.equal(result?.block, true);
});

test("extension blocks gh api merge", async () => {
	const handler = createExtensionHandler();
	const result = await handler(
		{
			type: "tool_call",
			toolCallId: "test",
			toolName: "bash",
			input: { command: "gh api repos/org/repo/pulls/123/merge -X PUT" },
		} as ToolCallEvent,
		ctx,
	);
	assert.equal(result?.block, true);
	assert.ok(typeof result?.reason === "string" && result.reason.includes("gh api"));
});

test("extension blocks explicit gh pr merge target", async () => {
	const handler = createExtensionHandler();
	const result = await handler(
		{ type: "tool_call", toolCallId: "test", toolName: "bash", input: { command: "gh pr merge 123" } } as ToolCallEvent,
		ctx,
	);
	assert.equal(result?.block, true);
	assert.ok(typeof result?.reason === "string" && result.reason.includes("Explicit"));
});

test("extension allows gh pr view", async () => {
	const handler = createExtensionHandler();
	const result = await handler(
		{ type: "tool_call", toolCallId: "test", toolName: "bash", input: { command: "gh pr view 123" } } as ToolCallEvent,
		ctx,
	);
	assert.equal(result, undefined);
});

// --- gh pr merge classification tests ---

test("allows only targetless gh pr merge commands with recognized options", () => {
	for (const command of [
		"gh pr merge",
		"gh pr merge --squash --delete-branch",
		"gh pr merge -A ava@example.com -b done -F body.md -m -r -s -d",
		"gh pr merge --admin --auto --disable-auto --author-email ava@example.com --body-file body.md --merge --rebase --squash",
		'gh pr merge --subject "release notes" --body=done --match-head-commit abc123',
		"gh --hostname github.example.com --config git_protocol=ssh pr merge --squash",
		"echo start; gh pr merge --merge",
		"gh pr merge --merge | tee merge.log",
	]) {
		assert.equal(classifyGhPrMerge(command), "current-branch", command);
	}
});

test("scans newlines and lone ampersands as command boundaries", () => {
	for (const command of ["echo start\ngh pr merge 123", "echo start & gh pr merge 123"]) {
		assert.equal(classifyGhPrMerge(command), "blocked", command);
	}
	for (const command of [
		"echo start\ngh api repos/org/repo/pulls/123/merge -X PUT",
		"echo start & gh api repos/org/repo/pulls/123/merge -X PUT",
	]) {
		assert.equal(containsGhApiMerge(command), true, command);
	}
});

test("blocks explicit or ambiguous gh pr merge targets", () => {
	for (const command of [
		"gh pr merge 123",
		"gh -R other/repo pr merge 123",
		"gh pr merge --squash 123",
		"gh pr merge https://github.com/org/repo/pull/123",
		"gh pr merge ava.silver/feature",
		"gh pr merge --repo org/repo",
		"gh pr merge --unknown",
		"gh pr merge 123 && echo merged",
		'gh pr merge "123"',
		"gh pr merge --body $(cat body.md)",
		"gh pr merge --squash > merge.log",
	]) {
		assert.equal(classifyGhPrMerge(command), "blocked", command);
	}
});

test("detects gh by executable basename", () => {
	for (const command of [
		"/usr/local/bin/gh pr merge",
		"g\\h pr merge",
		"/usr/local/bin/g\\h pr merge",
		'"/usr/local/bin/gh" pr merge',
	]) {
		assert.equal(classifyGhPrMerge(command), "current-branch", command);
	}
});

test("ignores non-merge gh commands", () => {
	assert.equal(classifyGhPrMerge("gh pr view 123"), "none");
});

test("ignores harmless compound commands", () => {
	for (const command of [
		"echo start; echo done",
		"true && echo done || echo failed",
		"printf '%s\\n' done | cat",
		'echo "a; b && c | d"',
	]) {
		assert.equal(classifyGhPrMerge(command), "none", command);
		assert.equal(containsGhApiMerge(command), false, command);
	}
});

test("unwraps rtk, gh assignments, and wrappers", () => {
	for (const command of [
		"GH_PROMPT_DISABLED=1 gh pr merge",
		"env gh pr merge",
		"command gh pr merge",
		"rtk gh pr merge",
		"rtk env GH_PROMPT_DISABLED=1 gh pr merge",
	]) {
		assert.equal(classifyGhPrMerge(command), "current-branch", command);
	}
	assert.equal(classifyGhPrMerge("rtk gh pr merge 123"), "blocked");
	for (const command of [
		"GH_PROMPT_DISABLED=1 gh api repos/org/repo/pulls/123/merge -X PUT",
		"env gh api repos/org/repo/pulls/123/merge -X PUT",
		"command gh api repos/org/repo/pulls/123/merge -X PUT",
		"rtk gh api repos/org/repo/pulls/123/merge -X PUT",
	]) {
		assert.equal(containsGhApiMerge(command), true, command);
	}
});

test("fails closed for unrecognized wrappers only with gh merge evidence", () => {
	assert.equal(classifyGhPrMerge("wrapper gh pr merge 123"), "blocked");
	assert.equal(containsGhApiMerge("wrapper gh api repos/org/repo/pulls/123/merge -X PUT"), true);
	for (const command of [
		"wrapper echo harmless",
		"wrapper gh pr view 123",
		"wrapper gh api repos/org/repo/pulls/123",
	]) {
		assert.equal(classifyGhPrMerge(command), "none", command);
		assert.equal(containsGhApiMerge(command), false, command);
	}
});

test("detects gh api merge endpoints and GraphQL mutations", () => {
	assert.equal(containsGhApiMerge("gh api repos/org/repo/pulls/123/merge -X PUT"), true);
	assert.equal(containsGhApiMerge("/usr/local/bin/gh api repos/org/repo/pulls/123/merge -X PUT"), true);
	assert.equal(containsGhApiMerge("g\\h api repos/org/repo/pulls/123/merge -X PUT"), true);
	assert.equal(containsGhApiMerge("/usr/local/bin/g\\h api repos/org/repo/pulls/123/merge -X PUT"), true);
	assert.equal(
		containsGhApiMerge('gh api graphql -f query="mutation { mergePullRequest(input: {}) { clientMutationId } }"'),
		true,
	);
	assert.equal(containsGhApiMerge("gh api repos/org/repo/pulls/123"), false);
});

// --- Shell parsing tests ---

test("shellWords tokenizes a simple command", () => {
	const { words, ambiguous } = shellWords("bazel build //src:lib");
	assert.deepEqual(words, ["bazel", "build", "//src:lib"]);
	assert.equal(ambiguous, false);
});

test("shellWords handles quoted arguments", () => {
	const { words, ambiguous } = shellWords('echo "hello world"');
	assert.deepEqual(words, ["echo", "hello world"]);
	assert.equal(ambiguous, false);
});

test("shellWords marks command substitution as ambiguous", () => {
	const { ambiguous } = shellWords("echo $(whoami)");
	assert.equal(ambiguous, true);
});

test("shellCommands splits on semicolons, pipes, ampersands, and newlines", () => {
	const commands = shellCommands("echo a; echo b | cat && echo c\necho d");
	assert.equal(commands.length, 5);
	assert.deepEqual(commands[0]?.words, ["echo", "a"]);
	assert.deepEqual(commands[1]?.words, ["echo", "b"]);
	assert.deepEqual(commands[2]?.words, ["cat"]);
	assert.deepEqual(commands[3]?.words, ["echo", "c"]);
	assert.deepEqual(commands[4]?.words, ["echo", "d"]);
});

test("findExecutable skips assignments and wrappers", () => {
	assert.equal(findExecutable(["bazel", "build"]), "bazel");
	assert.equal(findExecutable(["FOO=bar", "BAZ=qux", "bazel", "test"]), "bazel");
	assert.equal(findExecutable(["rtk", "bazel", "build"]), "bazel");
	assert.equal(findExecutable(["sudo", "bazel", "build"]), "bazel");
	assert.equal(findExecutable(["time", "bazel", "build"]), "bazel");
	assert.equal(findExecutable(["env", "GOOS=linux", "bazel", "build"]), "bazel");
	assert.equal(findExecutable(["env", "--", "bazel", "build"]), "bazel");
	assert.equal(findExecutable(["env", "-i", "bazel", "build"]), undefined);
	assert.equal(findExecutable(["command", "bazel", "build"]), "bazel");
	assert.equal(findExecutable(["rtk", "sudo", "env", "FOO=bar", "bazel", "build"]), "bazel");
	assert.equal(findExecutable([]), undefined);
});

test("basename extracts the last path segment", () => {
	assert.equal(basename("/usr/local/bin/bazel"), "bazel");
	assert.equal(basename("bazel"), "bazel");
	assert.equal(basename("./bzl"), "bzl");
});
