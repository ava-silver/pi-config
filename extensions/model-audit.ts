import type { Api, Model, ModelCost } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");
const REPORT_FILE = join(CACHE_DIR, "model-audit.html");
const CACHE_FILE = join(CACHE_DIR, "model-audit-cache.json");

const GATEWAY_MARKER = "ai-gateway";
const GPT_TIER_MODIFIERS = /^(pro|mini|nano|turbo|realtime|4o(-mini)?|codex(-spark)?|oss-\d+b)$/;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_CONCURRENCY = 8;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export type AuditedModel = {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  ok: boolean;
  error?: string;
  checkedAt: number;
};

export type FamilyGroup = {
  family: string;
  latest: AuditedModel;
  older: AuditedModel[];
  blockedNewer: AuditedModel[];
};

type CacheEntry = { ok: boolean; error?: string; checkedAt: number };

// --- Model family grouping ---------------------------------------------------

/**
 * Reduce a model ID to a product line: strip provider/org prefixes, date
 * snapshots, and `-latest`/`-preview` aliases, then remove every number that
 * is not glued to a trailing letter (so `4o` and `550b` stay in the name
 * while `4-8`, `5.2`, `o1`, and `v4` count as versions).
 */
export function modelFamily(id: string) {
  let bare = (id.split("/").pop() ?? id).toLowerCase();
  bare = bare.replace(/-\d{4}-\d{2}-\d{2}(?=-|$)/, "");
  bare = bare.replace(/-\d{8}(?=-|$)/, "");
  bare = bare.replace(/-\d{2}-\d{4}(?=-|$)/, "");
  bare = bare.replace(/-\d{4}(?=-|$)/, "");
  bare = bare.replace(/-(chat-)?latest$/, "");
  bare = bare.replace(/-preview$/, "");
  const versions: number[] = [];
  const parsed = bare
    .replace(/(?<![a-z0-9])\d+(?:\.\d+)*|\d+(?:\.\d+)*(?![a-z0-9])/g, (match, offset: number, whole: string) => {
      if (/[a-z]/.test(whole.charAt(offset + match.length))) return match;
      versions.push(...match.split(".").map(Number));
      return "";
    })
    .replace(/[-_.]+/g, "-")
    .replace(/^-|-$/g, "");
  // Special case: all OpenAI gpt-* tier variants (pro, mini, codex, ...) are
  // one family, and so are all o-series variants (o1, o3-mini, o3-pro, ...).
  // Unrecognized gpt-* suffixes are codenamed lines (sol, terra, luna, astra)
  // and stay separate; new codenames split off automatically.
  if (parsed === "gpt") return { family: "gpt", versions };
  if (parsed.startsWith("gpt-")) {
    const modifier = parsed.slice(4);
    return { family: GPT_TIER_MODIFIERS.test(modifier) ? "gpt" : `gpt-${modifier}`, versions };
  }
  if (parsed === "o" || parsed.startsWith("o-")) return { family: "o", versions };
  return { family: parsed, versions };
}

export function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? -1) - (right[index] ?? -1);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Group models across providers by family, keeping the newest working version.
 * Within a family prefer working models, then the shortest ID (the alias, not
 * a dated snapshot), then the cheapest.
 */
export function groupByFamily(models: AuditedModel[]) {
  const byKey = new Map<string, AuditedModel[]>();
  for (const model of models) {
    const key = modelFamily(model.id).family;
    byKey.set(key, [...(byKey.get(key) ?? []), model]);
  }
  const groups: FamilyGroup[] = [];
  const failed: AuditedModel[] = [];
  for (const [key, members] of byKey) {
    const sorted = members.toSorted(
      (a, b) =>
        compareVersions(modelFamily(b.id).versions, modelFamily(a.id).versions) ||
        Number(b.ok) - Number(a.ok) ||
        a.id.length - b.id.length ||
        a.cost.input + a.cost.output - (b.cost.input + b.cost.output) ||
        a.id.localeCompare(b.id) ||
        a.provider.localeCompare(b.provider),
    );
    const latest = sorted.find((model) => model.ok);
    if (latest === undefined) {
      failed.push(...sorted);
      continue;
    }
    const latestVersions = modelFamily(latest.id).versions;
    const blockedNewer = sorted.filter(
      (model) => !model.ok && compareVersions(modelFamily(model.id).versions, latestVersions) > 0,
    );
    groups.push({ family: key, latest, older: sorted.filter((model) => model.ok && model !== latest), blockedNewer });
    failed.push(...sorted.filter((model) => !model.ok && !blockedNewer.includes(model)));
  }
  const costOf = (model: AuditedModel) => model.cost.input + model.cost.output;
  groups.sort((a, b) => costOf(b.latest) - costOf(a.latest));
  failed.sort((a, b) => costOf(b) - costOf(a));
  return { groups, failed };
}

// --- HTML report ---------------------------------------------------------------

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function price(value: number): string {
  if (value === 0) return "$0";
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function tierNote(cost: ModelCost): string {
  return cost.tiers?.length ? "*" : "";
}

function modelCell(model: AuditedModel, blockedNewer: AuditedModel[]): string {
  const blocked =
    blockedNewer.length === 0
      ? ""
      : `<small class="blocked">Newer unavailable: ${escapeHtml(blockedNewer.map((model) => model.id).join(", "))}</small>`;
  return `<strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.provider)}/${escapeHtml(model.id)}</small>${blocked}`;
}

function modelRow(model: AuditedModel, blockedNewer: AuditedModel[] = []): string {
  return `<tr><td>${modelCell(model, blockedNewer)}</td><td>${price(model.cost.input)}${tierNote(model.cost)}</td><td>${price(model.cost.output)}${tierNote(model.cost)}</td><td>${price(model.cost.cacheRead)}</td><td>${tokens(model.contextWindow)}</td><td>${tokens(model.maxTokens)}</td><td>${model.reasoning ? "Yes" : "No"}</td></tr>`;
}

const TABLE_HEAD = `<tr><th>Model</th><th>Input /M</th><th>Output /M</th><th>Cache read /M</th><th>Context</th><th>Max output</th><th>Reasoning</th></tr>`;

/** Catch-all OpenAI families hidden from the main table; codenamed lines (sol, terra, ...) represent OpenAI instead. */
const HIDDEN_MAIN_FAMILIES = new Set(["gpt", "o"]);

export type ModelAuditInput = {
  generated: string;
  gatewayOnly: boolean;
  probedCount: number;
  cachedCount: number;
  models: AuditedModel[];
};

export function modelAuditHtml(input: ModelAuditInput): string {
  const { groups, failed } = groupByFamily(input.models);
  const working = groups.reduce((sum, group) => sum + 1 + group.older.length, 0);
  const visibleGroups = groups.filter((group) => !HIDDEN_MAIN_FAMILIES.has(group.family));
  const olderRows = [
    ...groups
      .filter((group) => HIDDEN_MAIN_FAMILIES.has(group.family))
      .flatMap((group) => [group.latest, ...group.older]),
    ...visibleGroups.flatMap((group) => group.older),
  ].toSorted((a, b) => b.cost.input + b.cost.output - (a.cost.input + a.cost.output));
  const mostRecent = Math.max(...input.models.map((model) => model.checkedAt));

  const mainTable =
    visibleGroups.length === 0
      ? '<p class="empty">No working models found.</p>'
      : `<table><thead>${TABLE_HEAD}</thead><tbody>${visibleGroups.map((group) => modelRow(group.latest, group.blockedNewer)).join("")}</tbody></table>`;
  const olderTable =
    olderRows.length === 0
      ? '<p class="empty">None</p>'
      : `<table><thead>${TABLE_HEAD}</thead><tbody>${olderRows.map((model) => modelRow(model)).join("")}</tbody></table>`;
  const failedTable =
    failed.length === 0
      ? '<p class="empty">None</p>'
      : `<table><thead><tr><th>Model</th><th>Error</th></tr></thead><tbody>${failed
          .map(
            (model) =>
              `<tr><td><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.provider)}/${escapeHtml(model.id)}</small></td><td class="error" title="${escapeHtml(model.error ?? "")}">${escapeHtml((model.error ?? "Unknown error").slice(0, 200))}</td></tr>`,
          )
          .join("")}</tbody></table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi model audit</title>
<style>
:root { color-scheme: light dark; --bg: #f7f7f5; --panel: #fff; --text: #202124; --muted: #687078; --border: #d9ddd9; --accent: #1769aa; --good: #29966f; --bad: #c34f65; }
@media (prefers-color-scheme: dark) { :root { --bg: #111412; --panel: #191d1a; --text: #e8ece9; --muted: #a6afa8; --border: #353c37; --accent: #76b7eb; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
main { width: min(1100px, calc(100% - 32px)); margin: 32px auto 64px; }
h1 { margin-bottom: 4px; font-size: 28px; }
h2 { margin: 36px 0 12px; font-size: 19px; }
p { margin: 6px 0; }
.subtitle, .empty { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 24px; }
.card, .notice, details { border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
.card { padding: 16px; }
.card strong { display: block; margin-top: 4px; font-size: 18px; }
.card span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.card.ok strong { color: var(--good); }
.card.bad strong { color: var(--bad); }
table { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
td:not(:first-child) { white-space: nowrap; font-variant-numeric: tabular-nums; }
td strong, td small { display: block; }
td small { color: var(--muted); overflow-wrap: anywhere; }
td small.blocked { color: var(--bad); }
td.error { white-space: normal; color: var(--bad); font-size: 13px; max-width: 420px; overflow-wrap: anywhere; }
details { margin: 8px 0; overflow: hidden; }
summary { cursor: pointer; padding: 12px 14px; font-weight: 600; }
details table { margin: 0 14px 14px; width: calc(100% - 28px); }
.notice { margin-top: 28px; padding: 14px; border-left: 4px solid var(--accent); }
</style>
</head>
<body>
<main>
<h1>Pi model audit</h1>
<p class="subtitle">Generated ${escapeHtml(input.generated)}. Probes run ${escapeHtml(new Date(mostRecent).toLocaleString())} or earlier. This local report does not enter model context.</p>
<div class="cards">
<div class="card"><span>Models discovered</span><strong>${input.models.length}</strong></div>
<div class="card ok"><span>Working</span><strong>${working}</strong></div>
<div class="card bad"><span>Not working</span><strong>${failed.length}</strong></div>
<div class="card"><span>Latest per family shown</span><strong>${visibleGroups.length}</strong></div>
<div class="card"><span>Probed now / cached</span><strong>${input.probedCount} / ${input.cachedCount}</strong></div>
</div>
<h2>Working models (latest version per family, by cost)</h2>
${mainTable}
<h2>Older working versions</h2>
<details><summary>Show ${olderRows.length} older version${olderRows.length === 1 ? "" : "s"}</summary>${olderTable}</details>
<h2>Not working</h2>
<details><summary>Show ${failed.length} model${failed.length === 1 ? "" : "s"}</summary>${failedTable}</details>
<p class="notice">Scope: ${input.gatewayOnly ? `models served through the Datadog AI Gateway (run <code>/model-audit --all</code> to include every provider)` : "all registered models"}. Each uncached model received one "Reply with: ok" request capped at 32 output tokens, so a full audit costs a few cents at most. Results are cached for 24 hours in <code>${escapeHtml(CACHE_FILE)}</code>; run <code>/model-audit --refresh</code> to re-probe. Families are model IDs with provider prefixes, date snapshots, <code>-latest</code>/<code>-preview</code> aliases, and version numbers removed, deduped across providers (for example, <code>glm-5.2</code>, <code>glm-5.3</code>, and <code>claude-haiku-4-5-20251001</code> collapse into their product line); the table shows the newest working version per family. All OpenAI <code>gpt-*</code> tier variants (<code>pro</code>, <code>mini</code>, <code>codex</code>, ...) form one family, all <code>o</code>-series variants another, and codenamed gpt lines (<code>sol</code>, <code>terra</code>, <code>luna</code>, <code>astra</code>) are separate families. The catch-all <code>gpt</code> and <code>o</code> families are hidden from the main table; their models appear under older working versions. Prices marked * are tiered; the base tier is shown.</p>
</main>
</body>
</html>`;
}

// --- Probing -------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probe(registry: ModelRegistry, model: Model<Api>): Promise<{ ok: boolean; error?: string }> {
  try {
    const message = await registry.complete(
      model,
      { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] },
      { maxTokens: 32, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return { ok: false, error: message.errorMessage ?? `Request ended with stopReason "${message.stopReason}"` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index] as T);
      }
    }),
  );
  return results;
}

async function readCache(): Promise<Record<string, CacheEntry>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

export default function modelAuditExtension(pi: ExtensionAPI): void {
  pi.registerCommand("model-audit", {
    description: "Probe which registered models actually work and open a cost-sorted HTML report",
    handler: async (args, ctx) => {
      const flags = new Set(args.split(/\s+/).filter(Boolean));
      const gatewayOnly = !flags.has("--all");
      const refresh = flags.has("--refresh");
      const models = ctx.modelRegistry
        .getAll()
        .filter((model) => !gatewayOnly || model.baseUrl.includes(GATEWAY_MARKER));
      if (models.length === 0) {
        ctx.ui.notify("No models found to audit", "warning");
        return;
      }

      const cache = refresh ? {} : await readCache();
      const keyOf = (model: Model<Api>) => `${model.provider}/${model.id}@${model.baseUrl}`;
      const cached = new Map(
        models.flatMap((model) => {
          const entry = cache[keyOf(model)];
          return entry !== undefined && Date.now() - entry.checkedAt < CACHE_TTL_MS
            ? [[keyOf(model), entry] as const]
            : [];
        }),
      );
      const toProbe = models.filter((model) => !cached.has(keyOf(model)));

      ctx.ui.notify(
        toProbe.length === 0
          ? `Model audit: using ${cached.size} cached probe results`
          : `Model audit: probing ${toProbe.length} models (${cached.size} cached)…`,
      );

      let done = 0;
      const probed = new Map(
        await mapPool(toProbe, PROBE_CONCURRENCY, async (model) => {
          const result = await probe(ctx.modelRegistry, model);
          done += 1;
          if (done % 10 === 0 || done === toProbe.length) {
            ctx.ui.notify(`Model audit: ${done}/${toProbe.length} probed`);
          }
          return [keyOf(model), result] as const;
        }),
      );

      const checkedAt = Date.now();
      const results: AuditedModel[] = models.map((model) => {
        const key = keyOf(model);
        const cacheHit = cached.get(key);
        const outcome = cacheHit ?? probed.get(key) ?? { ok: false, error: "Probe did not run" };
        if (!cacheHit) cache[key] = { ok: outcome.ok, ...(outcome.error ? { error: outcome.error } : {}), checkedAt };
        return {
          provider: model.provider,
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          ok: outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
          checkedAt: cacheHit?.checkedAt ?? checkedAt,
        };
      });

      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
      const html = modelAuditHtml({
        generated: new Date().toLocaleString(),
        gatewayOnly,
        probedCount: toProbe.length,
        cachedCount: cached.size,
        models: results,
      });
      await writeFile(REPORT_FILE, html, { mode: 0o600 });
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
      const commandArgs = process.platform === "win32" ? ["/c", "start", "", REPORT_FILE] : [REPORT_FILE];
      const open = await pi.exec(command, commandArgs, { timeout: 5_000 });
      const working = results.filter((model) => model.ok).length;
      ctx.ui.notify(
        `Model audit: ${working}/${results.length} models working${open.code === 0 ? "" : ` -- report at ${REPORT_FILE}`}`,
      );
    },
  });
}
