import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

export interface ShellCommand {
  words: string[];
  ambiguous: boolean;
}

/** Split a shell command list without evaluating expansions. */
export function shellCommands(command: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;

  const addCommand = (end: number) => commands.push(shellWords(command.slice(start, end)));
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (quote === "'") {
      if (char === quote) quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      addCommand(index);
      const isDoubleOperator = (char === "|" || char === "&") && command[index + 1] === char;
      start = index + (isDoubleOperator ? 2 : 1);
      if (isDoubleOperator) index++;
    }
  }
  addCommand(command.length);
  return commands;
}

/** Tokenize one simple command. Ambiguous shell syntax is retained but never evaluated. */
export function shellWords(command: string): ShellCommand {
  const words: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: "'" | '"' | undefined;
  let ambiguous = false;

  const addWord = () => {
    if (!hasWord) return;
    words.push(word);
    word = "";
    hasWord = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";
    if (quote === "'") {
      if (char === quote) quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === quote) quote = undefined;
      else if (char === "$" || char === "`") {
        ambiguous = true;
        word += char;
      } else if (char === "\\") {
        const next = command[++index];
        if (next === undefined || next === "\n") ambiguous = true;
        else word += next;
      } else word += char;
      continue;
    }
    if (char === "\\") {
      const next = command[++index];
      if (next === undefined || next === "\n") ambiguous = true;
      else {
        word += next;
        hasWord = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
      continue;
    }
    if (/\s/.test(char)) {
      addWord();
      continue;
    }
    if (";&|`$()<>*?[]{}!~".includes(char)) ambiguous = true;
    word += char;
    hasWord = true;
  }
  if (quote) ambiguous = true;
  addWord();
  return { words, ambiguous };
}

function isAssignment(word: string | undefined): boolean {
  return word !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

const SIMPLE_WRAPPERS = new Set(["rtk", "sudo", "time"]);

/** Find the executable, skipping leading assignments and common wrappers. */
export function findExecutable(words: string[]): string | undefined {
  let index = 0;
  for (;;) {
    while (isAssignment(words[index])) index++;
    const word = words[index];
    if (word === undefined) return undefined;
    if (SIMPLE_WRAPPERS.has(word)) {
      index++;
      continue;
    }
    if (word === "env") {
      index++;
      while (isAssignment(words[index])) index++;
      if (words[index] === "--" || words[index] === "-p") index++;
      else if (words[index]?.startsWith("-")) return undefined;
      continue;
    }
    if (word === "command") {
      index++;
      if (words[index] === "--" || words[index] === "-p") index++;
      else if (words[index]?.startsWith("-")) return undefined;
      continue;
    }
    return word;
  }
}

export function basename(word: string): string {
  return word.split("/").at(-1) ?? word;
}

// ---------------------------------------------------------------------------
// gh pr merge parsing
// ---------------------------------------------------------------------------

const GLOBAL_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname", "--config"]);
const VALUE_OPTIONS = new Set([
  "-A",
  "--author-email",
  "-b",
  "--body",
  "-F",
  "--body-file",
  "--match-head-commit",
  "--subject",
]);
const FLAG_OPTIONS = new Set([
  "--admin",
  "--auto",
  "-d",
  "--delete-branch",
  "--disable-auto",
  "-m",
  "--merge",
  "-r",
  "--rebase",
  "-s",
  "--squash",
]);
const GH_TIMEOUT_MS = 15_000;

export type MergeCommandClassification = "none" | "current-branch" | "blocked";

interface ParsedGhPrMerge {
  classification: MergeCommandClassification;
  globalOptions: string[];
}

function isGhExecutable(word: string | undefined): boolean {
  return word !== undefined && basename(word) === "gh";
}

/** Return the gh executable index after assignments and recognized wrappers. */
function ghExecutableIndex(words: string[]): number | undefined {
  let index = 0;
  for (;;) {
    while (isAssignment(words[index])) index++;
    if (words[index] === "rtk") {
      index++;
      continue;
    }
    if (words[index] === "env") {
      index++;
      while (isAssignment(words[index])) index++;
      if (words[index] === "--") index++;
      else if (words[index]?.startsWith("-")) return undefined;
      continue;
    }
    if (words[index] === "command") {
      index++;
      if (words[index] === "--" || words[index] === "-p") index++;
      else if (words[index]?.startsWith("-")) return undefined;
      continue;
    }
    return isGhExecutable(words[index]) ? index : undefined;
  }
}

function optionParts(option: string): [string, string | undefined] {
  const equals = option.indexOf("=");
  return equals === -1 ? [option, undefined] : [option.slice(0, equals), option.slice(equals + 1)];
}

function parseSimpleGhPrMerge(command: ShellCommand): ParsedGhPrMerge {
  const ghIndex = ghExecutableIndex(command.words);
  if (ghIndex === undefined) return { classification: "none", globalOptions: [] };

  const globalOptions: string[] = [];
  let hasExplicitRepository = false;
  let index = ghIndex + 1;
  for (; index < command.words.length; index++) {
    const option = command.words[index];
    if (option === undefined) return { classification: "blocked", globalOptions: [] };
    if (option === "pr") break;
    const [name, inlineValue] = optionParts(option);
    if (!GLOBAL_VALUE_OPTIONS.has(name)) return { classification: "none", globalOptions: [] };
    globalOptions.push(option);
    if (inlineValue === undefined) {
      const value = command.words[++index];
      if (value === undefined) return { classification: "blocked", globalOptions: [] };
      globalOptions.push(value);
    }
    if (name === "-R" || name === "--repo") hasExplicitRepository = true;
  }
  if (command.words[index] !== "pr" || command.words[index + 1] !== "merge") {
    return { classification: "none", globalOptions: [] };
  }
  if (command.ambiguous || hasExplicitRepository) return { classification: "blocked", globalOptions: [] };

  for (index += 2; index < command.words.length; index++) {
    const option = command.words[index];
    if (option === undefined) return { classification: "blocked", globalOptions: [] };
    const [name, inlineValue] = optionParts(option);
    if (FLAG_OPTIONS.has(name) && inlineValue === undefined) continue;
    if (VALUE_OPTIONS.has(name) && (inlineValue !== undefined || command.words[++index] !== undefined)) continue;
    return { classification: "blocked", globalOptions: [] };
  }
  return { classification: "current-branch", globalOptions };
}

function simpleCommandContainsGhPrMergeEvidence(command: ShellCommand): boolean {
  if (ghExecutableIndex(command.words) !== undefined) return false;
  return command.words.some(
    (word, index) =>
      isGhExecutable(word) &&
      parseSimpleGhPrMerge({ ...command, words: command.words.slice(index) }).classification !== "none",
  );
}

export function parseGhPrMerge(command: string): ParsedGhPrMerge {
  let currentBranch: ParsedGhPrMerge | undefined;
  for (const simpleCommand of shellCommands(command)) {
    const parsed = parseSimpleGhPrMerge(simpleCommand);
    if (parsed.classification === "blocked" || simpleCommandContainsGhPrMergeEvidence(simpleCommand)) {
      return { classification: "blocked", globalOptions: [] };
    }
    if (parsed.classification === "current-branch") {
      if (currentBranch) return { classification: "blocked", globalOptions: [] };
      currentBranch = parsed;
    }
  }
  return currentBranch ?? { classification: "none", globalOptions: [] };
}

/** Classify `gh pr merge` invocations, allowing only recognized options with no PR target. */
export function classifyGhPrMerge(command: string): MergeCommandClassification {
  return parseGhPrMerge(command).classification;
}

function ghApiMergeAt(command: ShellCommand, ghIndex: number): boolean {
  let index = ghIndex + 1;
  for (; index < command.words.length; index++) {
    const option = command.words[index];
    if (option === undefined) return false;
    if (option === "api") break;
    const [name, inlineValue] = optionParts(option);
    if (!GLOBAL_VALUE_OPTIONS.has(name)) return false;
    if (inlineValue === undefined && command.words[++index] === undefined) return false;
  }
  if (command.words[index] !== "api") return false;
  return command.words.slice(index + 1).some((word) => /mergePullRequest|\/merge(?:\b|$)/i.test(word));
}

function simpleCommandContainsGhApiMerge(command: ShellCommand): boolean {
  const ghIndex = ghExecutableIndex(command.words);
  if (ghIndex !== undefined) return ghApiMergeAt(command, ghIndex);
  return command.words.some((word, index) => isGhExecutable(word) && ghApiMergeAt(command, index));
}

export function containsGhApiMerge(command: string): boolean {
  return shellCommands(command).some(simpleCommandContainsGhApiMerge);
}

async function gh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS });
  return stdout.trim();
}

/** Verify that the current branch's PR belongs to the authenticated user. */
async function verifyCurrentBranchPr(merge: ParsedGhPrMerge, cwd: string): Promise<string | undefined> {
  try {
    const [viewer, pr] = await Promise.all([
      gh(cwd, [...merge.globalOptions, "api", "user", "--jq", ".login"]),
      gh(cwd, [...merge.globalOptions, "pr", "view", "--json", "author,headRefName"]),
    ]);
    const details = JSON.parse(pr) as { author?: { login?: string }; headRefName?: string };
    if (details.author?.login !== viewer || !details.headRefName?.startsWith(`${viewer}/`)) {
      return "Only the authenticated user's branch PR may be merged. Do not bypass this guard.";
    }
  } catch (error) {
    return `Could not verify the current branch PR: ${error instanceof Error ? error.message : String(error)}. Do not bypass this guard.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Block rules
// ---------------------------------------------------------------------------

export interface BlockRule {
  commands: string[];
  reason?: string;
  check?: (command: string, ctx: ExtensionContext) => string | undefined | null | Promise<string | undefined | null>;
}

const rules: BlockRule[] = [
  {
    commands: ["bzl", "bazel"],
    reason:
      "Bazel/bzl builds are extremely slow and should only run in CI. Use `go` commands (go build, go test, go vet) for local builds and tests instead.",
  },
  {
    commands: ["gh"],
    check: async (command, ctx) => {
      if (containsGhApiMerge(command)) {
        return "PR merges through gh api are blocked. Do not bypass this guard; use gh pr merge from the current branch.";
      }
      const merge = parseGhPrMerge(command);
      if (merge.classification === "none") return undefined;
      if (merge.classification !== "current-branch") {
        return "Explicit or ambiguous PR targets are blocked. Merge only the current branch's PR with recognized options.";
      }
      return verifyCurrentBranchPr(merge, ctx.cwd);
    },
  },
];

/** Find the first matching block rule for a command string. */
export async function findBlockedCommand(
  command: string,
  ruleSet: BlockRule[],
  ctx: ExtensionContext,
): Promise<string | undefined> {
  if (ruleSet.length === 0) return undefined;

  const executables = new Set<string>();
  for (const simpleCommand of shellCommands(command)) {
    const exe = findExecutable(simpleCommand.words);
    if (exe) executables.add(basename(exe).toLowerCase());
  }

  for (const rule of ruleSet) {
    const matches = rule.commands.some((cmd) => executables.has(cmd.toLowerCase()));
    if (!matches) continue;
    if (rule.check) {
      const reason = await rule.check(command, ctx);
      if (reason) return reason;
    } else if (rule.reason) {
      return rule.reason;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function commandBlockerExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (
      !isToolCallEventType("bash", event) &&
      !isToolCallEventType<"background_shell_run", { command: string }>("background_shell_run", event)
    )
      return;

    const reason = await findBlockedCommand(event.input.command, rules, ctx);
    if (reason) return { block: true, reason };
  });
}
