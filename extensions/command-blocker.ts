import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

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
