/** All model-facing strings for the subagents tools. */

/** Describes subagent_spawn, including models curated for the parent session. */
export function buildSubagentSpawnToolDescription(modelExamples: readonly string[]) {
  const scopedModels =
    modelExamples.length > 0 ? ` Scoped model examples: ${modelExamples.map((model) => `"${model}"`).join(", ")}.` : "";
  return (
    "Spawn a background subagent: a headless pi agent with its own context window. Spawning starts work in the background and returns an id immediately. You can message, inspect, wait for, or cancel the subagent. Its result is delivered automatically when it settles. Children cannot orchestrate more agents or ask the user directly, and cannot see this conversation. Give the child enough context to start; it can ask you through ask_parent for clarification, decisions, or missing context that could improve the result. Max 16 subagents can run at once." +
    scopedModels
  );
}

/** Adds background subagent delegation to the parent model's available-tools prompt. */
export const SUBAGENT_SPAWN_PROMPT_SNIPPET =
  "Spawn a background pi subagent (own context, normal tools) for a self-contained task";

/** Guides the parent model to delegate standalone tasks and avoid unnecessary blocking waits. */
export const SUBAGENT_SPAWN_PROMPT_GUIDELINES = [
  "Use subagent_spawn to delegate tasks that can run in the background. Give the child enough context to start, and invite it to ask_parent for clarification, decisions, or missing context that could improve the result.",
  "After subagent_spawn, keep working; results arrive automatically. Use subagent_message, subagent_check, subagent_wait, or subagent_cancel whenever needed; call subagent_wait when you cannot proceed without the result.",
  "Use subagent_message to steer a subagent or answer its pending question. Use ask_user first only when the answer requires the user's input.",
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
  "Block until all listed subagents settle or ask a parent question. Returns the interrupting question or final output for each child. Cancelling this wait leaves children running. Prefer automatic delivery; use this only when you need a result before continuing.";

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
  "Peek at a subagent's status, current activity, and latest progress without blocking. Does not consume its result.";

/** Model-facing schema description for the subagent id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
};

/** Describes listing all tracked running and settled subagents. */
export const SUBAGENT_LIST_TOOL_DESCRIPTION = "List all subagents (running and finished) with their status.";

export const SUBAGENT_MESSAGE_TOOL_DESCRIPTION =
  "Send a message to a subagent. If it has a pending question, the message answers it. Otherwise, it steers the current run or reactivates a settled child into a new run. Reactivation keeps the child's on-disk transcript while it remains tracked (up to 64 children per parent session).";

export const SUBAGENT_MESSAGE_PARAMETER_DESCRIPTIONS = {
  id: "Subagent id",
  message: "Answer, context, correction, or additional instruction for the subagent",
};

export function buildSubagentQuestionMessage(options: { id: string; title: string; question: string }) {
  return (
    `Subagent ${options.id} "${options.title}" asks:\n\n${options.question}\n\n` +
    `Reply with subagent_message({ id: "${options.id}", message: "..." }). ` +
    "The subagent is blocked until you reply. If the answer requires the user's input, ask the user first."
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
