import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CACHE_FILE = "repository-context.json";
const GITLAB_HOST = "gitlab.ddbuild.io";
const METADATA_TIMEOUT_MS = 10_000;

export type RepositoryVisibility = "public" | "private" | "internal" | "unknown";
export type CiProvider = "github" | "gitlab";

export interface CiLocation {
  provider: CiProvider;
  project: string;
  url: string;
}

export interface RepositoryMetadata {
  visibility: RepositoryVisibility;
  ci: CiLocation[];
}

export interface RepositoryContext extends RepositoryMetadata {
  url: string;
  organization: string;
  repository: string;
}

export type RepositoryCache = Record<string, RepositoryMetadata>;

export interface ParsedRemote {
  key: string;
  name: string;
  context: RepositoryContext;
}

const emptyCache = (): RepositoryCache => ({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCiLocation(value: unknown): value is CiLocation {
  return (
    isRecord(value) &&
    (value.provider === "github" || value.provider === "gitlab") &&
    typeof value.project === "string" &&
    typeof value.url === "string"
  );
}

function isRepositoryMetadata(value: unknown): value is RepositoryMetadata {
  if (!isRecord(value)) return false;
  return (
    ["public", "private", "internal", "unknown"].includes(String(value.visibility)) &&
    Array.isArray(value.ci) &&
    value.ci.every(isCiLocation)
  );
}

export function getRepositoryCachePath(agentDir = getAgentDir()): string {
  return join(agentDir, CACHE_FILE);
}

export function readRepositoryCache(cachePath = getRepositoryCachePath()): RepositoryCache {
  if (!existsSync(cachePath)) return emptyCache();

  const value = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
  if (!isRecord(value) || !Object.values(value).every(isRepositoryMetadata)) {
    throw new Error("one or more repository entries are invalid");
  }

  return value as RepositoryCache;
}

export function writeRepositoryContext(
  key: string,
  context: RepositoryContext,
  cachePath = getRepositoryCachePath(),
): void {
  const cache = readRepositoryCache(cachePath);
  const next: RepositoryCache = {
    ...cache,
    [key]: { visibility: context.visibility, ci: context.ci },
  };
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, cachePath);
}

export function parseRepositoryRemote(remote: string): Omit<ParsedRemote, "name"> | undefined {
  const trimmed = remote.trim();
  const scpMatch = trimmed.includes("://") ? null : trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  const urlText = scpMatch ? `ssh://${scpMatch[1]}/${scpMatch[2]}` : trimmed;

  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== "github.com" && !hostname.endsWith(".github.com")) return undefined;

  const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  const parts = path.split("/").filter(Boolean);
  const repository = parts.at(-1);
  if (!repository || parts.length !== 2) return undefined;

  const organization = parts[0] ?? "";
  const canonicalUrl = `https://github.com/${organization}/${repository}`;
  return {
    key: canonicalUrl,
    context: {
      url: canonicalUrl,
      organization,
      repository,
      visibility: "unknown",
      ci: [],
    },
  };
}

export function parseGitHubRemotes(config: string): ParsedRemote[] {
  return config
    .split("\n")
    .map((line) => line.trim().match(/^remote\.([^.]*)\.url\s+(.+)$/))
    .flatMap((match) => {
      if (!match?.[1] || !match[2]) return [];
      const parsed = parseRepositoryRemote(match[2]);
      return parsed ? [{ ...parsed, name: match[1] }] : [];
    });
}

export function selectGitHubRemote(remotes: ParsedRemote[]): ParsedRemote | undefined {
  return remotes.find((remote) => remote.name === "origin") ?? remotes[0];
}

export function detectCi(root: string): CiProvider[] {
  return [
    ...(existsSync(join(root, ".github", "workflows")) ? (["github"] as const) : []),
    ...(existsSync(join(root, ".gitlab-ci.yml")) || existsSync(join(root, ".gitlab-ci.yaml"))
      ? (["gitlab"] as const)
      : []),
  ];
}

function normalizeVisibility(value: unknown): RepositoryVisibility {
  const visibility = String(value).toLowerCase();
  return visibility === "public" || visibility === "private" || visibility === "internal" ? visibility : "unknown";
}

function offline(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
}

async function commandOutput(pi: ExtensionAPI, command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await pi.exec(command, args, { timeout: METADATA_TIMEOUT_MS });
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function githubAuthHost(organization: string): string {
  return ["ddoghq", "ddoghq-sandbox", "ava-silver_ddog"].includes(organization.toLowerCase())
    ? "ddoghq.github.com"
    : "github.com";
}

async function loadGitHubVisibility(pi: ExtensionAPI, context: RepositoryContext): Promise<RepositoryVisibility> {
  if (offline()) return "unknown";
  const output = await commandOutput(pi, "env", [
    `GH_HOST=${githubAuthHost(context.organization)}`,
    "gh",
    "repo",
    "view",
    context.url,
    "--json",
    "visibility",
  ]);
  if (!output) return "unknown";

  try {
    const value = JSON.parse(output) as unknown;
    return isRecord(value) ? normalizeVisibility(value.visibility) : "unknown";
  } catch {
    return "unknown";
  }
}

async function gitLabCiLocation(pi: ExtensionAPI, repository: string): Promise<CiLocation> {
  const project = `DataDog/${repository}`;
  const fallback: CiLocation = {
    provider: "gitlab",
    project,
    url: `https://${GITLAB_HOST}/${project}`,
  };
  if (offline()) return fallback;

  const output = await commandOutput(pi, "glab", [
    "api",
    "--hostname",
    GITLAB_HOST,
    `projects/${encodeURIComponent(project)}`,
  ]);
  if (!output) return fallback;

  try {
    const value = JSON.parse(output) as unknown;
    if (!isRecord(value)) return fallback;
    return {
      provider: "gitlab",
      project: typeof value.path_with_namespace === "string" ? value.path_with_namespace : fallback.project,
      url: typeof value.web_url === "string" ? value.web_url : fallback.url,
    };
  } catch {
    return fallback;
  }
}

async function discoverRepository(
  pi: ExtensionAPI,
  root: string,
  remote: ParsedRemote,
): Promise<{ key: string; context: RepositoryContext }> {
  const context = {
    ...remote.context,
    visibility: await loadGitHubVisibility(pi, remote.context),
  };
  const providers = detectCi(root);
  const ci = await Promise.all(
    providers.map((provider): Promise<CiLocation> => {
      if (provider === "gitlab") return gitLabCiLocation(pi, context.repository);
      return Promise.resolve({
        provider: "github",
        project: `${context.organization}/${context.repository}`,
        url: `${context.url}/actions`,
      });
    }),
  );

  return { key: remote.key, context: { ...context, ci } };
}

function ciLabel(provider: CiProvider): string {
  return provider === "github" ? "GitHub Actions" : "GitLab CI";
}

export function buildRepositoryPrompt(context: RepositoryContext): string {
  const ci =
    context.ci.length === 0
      ? "- CI: not detected"
      : `- CI:\n${context.ci
          .map((location) => `  - ${ciLabel(location.provider)}: ${location.project} (${location.url})`)
          .join("\n")}`;
  const authHost = githubAuthHost(context.organization);
  const authGuidance =
    authHost === "github.com"
      ? `Use \`gh\` with the GitHub authentication for ${context.organization}.`
      : `Use \`gh\` with the ${context.organization} authentication by setting \`GH_HOST=${authHost}\`.`;
  const gitLabProject = context.ci.find((location) => location.provider === "gitlab")?.project;
  const gitLabGuidance = gitLabProject
    ? ` For GitLab CI commands, pass \`--repo ${gitLabProject}\` because GitLab is only the CI mirror and the Git remote points to GitHub.`
    : "";
  return `## Repository context

- GitHub repository: ${context.organization}/${context.repository}
- URL: ${context.url}
- Visibility: ${context.visibility}
${ci}

Use GitHub for code and pull request operations. ${authGuidance}${gitLabGuidance}`;
}

export default function repositoryContextExtension(pi: ExtensionAPI): void {
  let cacheKey: string | undefined;
  let context: RepositoryContext | undefined;
  let contextReady: Promise<void> | undefined;
  const cachePath = getRepositoryCachePath();

  pi.on("session_start", (_event, ctx) => {
    cacheKey = undefined;
    context = undefined;
    if (!ctx.isProjectTrusted()) return;

    // Fire off git discovery without blocking the prompt from appearing.
    // before_agent_start awaits contextReady before injecting the system prompt.
    contextReady = (async () => {
      const [root, remoteConfig] = await Promise.all([
        commandOutput(pi, "git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"]),
        commandOutput(pi, "git", ["-C", ctx.cwd, "config", "--get-regexp", "^remote\\..*\\.url$"]),
      ]);
      const remote = remoteConfig ? selectGitHubRemote(parseGitHubRemotes(remoteConfig)) : undefined;
      if (!root || !remote) return;
      cacheKey = remote.key;

      let cacheValid = true;
      try {
        const metadata = readRepositoryCache(cachePath)[cacheKey];
        context = metadata ? { ...remote.context, ...metadata } : undefined;
      } catch (error) {
        cacheValid = false;
        if (ctx.hasUI) ctx.ui.notify(`Repository cache is invalid: ${String(error)}`, "warning");
      }
      if (context) return;

      const discovered = await discoverRepository(pi, root, remote);
      context = discovered.context;
      if (!cacheValid) return;
      try {
        writeRepositoryContext(discovered.key, discovered.context, cachePath);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Could not update repository cache: ${String(error)}`, "warning");
      }
    })();
  });

  pi.on("before_agent_start", async (event) => {
    await contextReady;
    if (cacheKey) {
      try {
        const metadata = readRepositoryCache(cachePath)[cacheKey];
        const remote = parseRepositoryRemote(cacheKey);
        if (metadata && remote) context = { ...remote.context, ...metadata };
      } catch {
        // Keep the context loaded at session start until the cache is valid again.
      }
    }
    if (!context) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${buildRepositoryPrompt(context)}` };
  });
}
