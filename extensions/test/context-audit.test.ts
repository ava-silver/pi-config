import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contextAuditHtml } from "../context-audit.ts";

const messageEntry: SessionEntry = {
	type: "message",
	id: "entry-1",
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "hello" }],
		timestamp: 1,
	},
};

test("renders model-visible sources and context visualizations", () => {
	const html = contextAuditHtml({
		systemPrompt: "system instructions",
		options: {
			cwd: "/project",
			contextFiles: [{ path: "/project/AGENTS.md", content: "instructions" }],
			skills: [],
		},
		activeToolNames: ["read", "custom"],
		tools: [
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object" },
				sourceInfo: { path: "<builtin:read>", source: "builtin" },
			},
			{
				name: "custom",
				description: "Custom tool",
				parameters: { type: "object" },
				sourceInfo: { path: "/extensions/custom.ts", source: "auto" },
			},
		],
		contextEntries: [messageEntry],
	});

	assert.match(html, /What uses context/);
	assert.match(html, /Top-level distribution/);
	assert.match(html, /Tool definitions by source/);
	assert.match(html, /Largest conversation messages/);
	assert.match(html, /\/project\/AGENTS\.md/);
	assert.match(html, /&lt;builtin:read&gt;/);
	assert.match(html, />local</);
	assert.doesNotMatch(html, />auto</);
	assert.match(html, /Full prompt/);
	assert.match(html, /<span>System prompt<\/span><strong>2 estimated tokens<\/strong>/);
	assert.match(html, /<summary>1\. user<span>2 estimated tokens<\/span><\/summary>/);
	assert.match(html, /o200k_base/);
	assert.doesNotMatch(html, /JSON character counts/);
});

test("escapes model-controlled HTML", () => {
	const html = contextAuditHtml({
		systemPrompt: "<script>alert(1)</script>",
		options: { cwd: "/project" },
		activeToolNames: [],
		tools: [],
		contextEntries: [],
	});

	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;script&gt;alert/);
});
