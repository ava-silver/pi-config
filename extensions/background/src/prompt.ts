/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn. */
export const SUBAGENT_SPAWN_TOOL_DESCRIPTION =
  "Spawn a background subagent: a headless pi agent with its own context window. Fire-and-forget: this returns immediately with an id. The subagent's final output is queued back to you as a message when it settles, or collect it explicitly with subagent_wait. Children cannot orchestrate more agents or ask the user directly, and cannot see this conversation. Give the child enough context to start; it can ask you through ask_parent for clarification, decisions, or missing context that could improve the result. Max 16 subagents can run at once.";

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background pi subagent (own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate tasks that can run in the background. Give the child enough context to start, and invite it to ask_parent for clarification, decisions, or missing context that could improve the result.",
  "After subagent_spawn, keep working; results arrive automatically. Only call subagent_wait when you cannot proceed without the result.",
  "When a subagent asks a question, answer it with subagent_answer. Use ask_user first only when the answer requires the user's input.",
];

/** Model-facing schema descriptions for subagent_spawn task and execution options. */
export const SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS = {
  prompt:
    "Task prompt for the subagent. Include enough context, file paths, and expected output to start; it can ask_parent for clarification or missing context.",
  name: "Short human-readable name for this subagent, shown in listings and the UI",
  workingDir: "Working directory (default: current working directory)",
  model: '"provider/model-id" or bare model id. Omit to inherit the current model.',
  reasoningEffort: "Reasoning effort (pi thinking level). Omit to inherit the current level.",
};

/** Builds the subagent_spawn result that tells the parent model how to continue or inspect the child. */
export function buildSubagentSpawnResult(options: { id: string; title: string; modelLabel: string; cwd: string }) {
  return (
    `Spawned subagent ${options.id} "${options.title}" (${options.modelLabel}, ${options.cwd}).\n` +
    `It runs in the background. Its result will be delivered to you when it finishes, ` +
    `or use subagent_wait(ids: ["${options.id}"]) to block for it, subagent_cancel to stop it, subagent_check to peek, subagent_list to see all.`
  );
}

/** Describes explicit blocking collection of one or more subagent results. */
export const SUBAGENT_WAIT_TOOL_DESCRIPTION =
  "Block until all listed subagents have settled or need an answer. Returns final outputs and any pending questions. Prefer automatic delivery; use this only when you need a result before continuing.";

/** Model-facing schema description for the subagent ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to wait for, e.g. ["sa-1", "sa-2"]',
};

/** Describes aborting running subagents while retaining their partial transcripts. */
export const SUBAGENT_CANCEL_TOOL_DESCRIPTION =
  "Cancel one or more running subagents. This aborts their active work but preserves their partial session transcripts on disk.";

/** Model-facing schema description for the subagent ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent ids to cancel, e.g. ["sa-1", "sa-2"]',
};

/** Describes nonblocking inspection of a subagent without consuming its result. */
export const SUBAGENT_CHECK_TOOL_DESCRIPTION =
  "Peek at a subagent's status and recent activity without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION = "List all subagents (running and finished) with their status.";

export const SUBAGENT_ANSWER_TOOL_DESCRIPTION =
  "Answer the oldest pending question from a subagent. The answer is delivered directly to the child's blocked ask_parent call so it can continue its current run.";

export const SUBAGENT_ANSWER_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id that asked the question",
  answer: "Direct answer with the context or decision the subagent needs",
};

export function buildSubagentQuestionMessage(options: { id: string; title: string; question: string }) {
  return (
    `Subagent ${options.id} "${options.title}" asks:\n\n${options.question}\n\n` +
    `Answer with subagent_answer({ id: "${options.id}", answer: "..." }). ` +
    "If the answer requires the user's input, ask the user first."
  );
}

/** Builds the child completion/failure wrapper injected into the parent model's context. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}) {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  text += `\n\n${options.output}`;
  return text;
}
