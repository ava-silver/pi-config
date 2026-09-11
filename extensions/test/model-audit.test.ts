import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, groupByFamily, modelAuditHtml, modelFamily, type AuditedModel } from "../model-audit.ts";

function model(overrides: Partial<AuditedModel> & { id: string }): AuditedModel {
  return {
    provider: "anthropic",
    name: overrides.id,
    reasoning: false,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ok: true,
    checkedAt: 1,
    ...overrides,
  };
}

test("modelFamily strips provider prefixes and version numbers", () => {
  assert.deepEqual(modelFamily("baseten/zai-org/GLM-5.2"), { family: "glm", versions: [5, 2] });
  assert.deepEqual(modelFamily("claude-opus-4-8"), { family: "claude-opus", versions: [4, 8] });
  assert.deepEqual(modelFamily("claude-opus-5"), { family: "claude-opus", versions: [5] });
  assert.deepEqual(modelFamily("gpt-5.6-sol"), { family: "gpt-sol", versions: [5, 6] });
  assert.deepEqual(modelFamily("gpt-5.5-pro"), { family: "gpt", versions: [5, 5] });
  assert.deepEqual(modelFamily("gpt-5.4-mini"), { family: "gpt", versions: [5, 4] });
  assert.deepEqual(modelFamily("gpt-5.3-codex-spark"), { family: "gpt", versions: [5, 3] });
  assert.deepEqual(modelFamily("gpt-6-astra"), { family: "gpt-astra", versions: [6] });
});

test("modelFamily strips date snapshots and latest/preview aliases", () => {
  assert.deepEqual(modelFamily("claude-haiku-4-5-20251001"), { family: "claude-haiku", versions: [4, 5] });
  assert.deepEqual(modelFamily("gpt-4o-2024-05-13"), { family: "gpt", versions: [] });
  assert.deepEqual(modelFamily("gpt-5.2-chat-latest"), { family: "gpt", versions: [5, 2] });
  assert.deepEqual(modelFamily("gemini-flash-latest"), { family: "gemini-flash", versions: [] });
  assert.deepEqual(modelFamily("deepseek-ai/DeepSeek-V4-Flash-0731"), { family: "deepseek-v-flash", versions: [4] });
  assert.deepEqual(modelFamily("gemini-3.1-pro-preview"), { family: "gemini-pro", versions: [3, 1] });
});

test("modelFamily keeps letter-glued numbers in the name", () => {
  assert.deepEqual(modelFamily("gpt-4o"), { family: "gpt", versions: [] });
  assert.deepEqual(modelFamily("o3-mini"), { family: "o", versions: [3] });
  assert.deepEqual(modelFamily("nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B"), {
    family: "nvidia-nemotron-ultra-550b-a55b",
    versions: [3],
  });
});

test("compareVersions orders numerically, not lexicographically", () => {
  assert.ok(compareVersions([4, 10], [4, 8]) > 0);
  assert.ok(compareVersions([5, 2], [5, 10]) < 0);
  assert.ok(compareVersions([5, 2], [5]) > 0);
  assert.equal(compareVersions([5, 2], [5, 2]), 0);
});

test("groupByFamily keeps only the newest working version per family", () => {
  const { groups, failed } = groupByFamily([
    model({ id: "glm-5.2", provider: "baseten" }),
    model({ id: "glm-5.3", provider: "baseten", ok: false, error: "access denied" }),
    model({ id: "glm-5.1", provider: "baseten" }),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.latest.id, "glm-5.2");
  assert.deepEqual(
    groups[0]?.older.map((item) => item.id),
    ["glm-5.1"],
  );
  assert.deepEqual(
    groups[0]?.blockedNewer.map((item) => item.id),
    ["glm-5.3"],
  );
  assert.deepEqual(failed, []);
});

test("groupByFamily collapses dated snapshots and dedupes across providers", () => {
  const { groups, failed } = groupByFamily([
    model({ id: "claude-haiku-4-5-20251001", provider: "anthropic" }),
    model({ id: "claude-haiku-4-5", provider: "anthropic" }),
    model({ id: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731", provider: "dd-ai-gateway" }),
    model({ id: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731", provider: "baseten" }),
    model({ id: "o1", provider: "openai" }),
    model({ id: "o3", provider: "openai" }),
  ]);

  assert.equal(groups.length, 3);
  const haiku = groups.find((group) => group.family === "claude-haiku");
  assert.equal(haiku?.latest.id, "claude-haiku-4-5");
  assert.deepEqual(
    haiku?.older.map((item) => item.id),
    ["claude-haiku-4-5-20251001"],
  );
  const deepseek = groups.find((group) => group.family === "deepseek-v-flash");
  assert.equal(deepseek?.older.length, 1);
  const oSeries = groups.find((group) => group.family === "o");
  assert.equal(oSeries?.latest.id, "o3");
  assert.deepEqual(failed, []);
});

test("groupByFamily collapses gpt tiers but keeps codenamed lines and o-series separate", () => {
  const { groups, failed } = groupByFamily([
    model({ id: "gpt-4o", provider: "openai" }),
    model({ id: "gpt-5.5", provider: "openai" }),
    model({ id: "gpt-5.5-pro", provider: "openai" }),
    model({ id: "gpt-5.6-sol", provider: "openai" }),
    model({ id: "gpt-5.6-terra", provider: "openai" }),
    model({ id: "o1", provider: "openai" }),
    model({ id: "o3", provider: "openai" }),
    model({ id: "o3-pro", provider: "openai" }),
    model({ id: "o4-mini", provider: "openai" }),
  ]);

  assert.deepEqual(groups.map((group) => group.family).sort(), ["gpt", "gpt-sol", "gpt-terra", "o"]);
  const gpt = groups.find((group) => group.family === "gpt");
  assert.equal(gpt?.latest.id, "gpt-5.5");
  assert.deepEqual(
    gpt?.older.map((item) => item.id),
    ["gpt-5.5-pro", "gpt-4o"],
  );
  const oSeries = groups.find((group) => group.family === "o");
  assert.equal(oSeries?.latest.id, "o4-mini");
  assert.deepEqual(failed, []);
});

test("groupByFamily sorts families by cost", () => {
  const { groups } = groupByFamily([
    model({ id: "glm-5.3", provider: "baseten", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
    model({ id: "claude-opus-5", provider: "anthropic", cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.latest.id),
    ["claude-opus-5", "glm-5.3"],
  );
});

test("groupByFamily reports fully inaccessible families as failed", () => {
  const { groups, failed } = groupByFamily([model({ id: "glm-5.3", ok: false, error: "nope" })]);

  assert.deepEqual(groups, []);
  assert.deepEqual(
    failed.map((item) => item.id),
    ["glm-5.3"],
  );
});

test("report hides catch-all gpt and o families from the main table", () => {
  const html = modelAuditHtml({
    generated: "now",
    gatewayOnly: true,
    probedCount: 3,
    cachedCount: 0,
    models: [
      model({ id: "gpt-5.5", provider: "openai" }),
      model({ id: "gpt-5.6-sol", provider: "openai" }),
      model({ id: "o4-mini", provider: "openai" }),
      model({ id: "claude-opus-5", provider: "anthropic" }),
    ],
  });

  const mainTable = html.split("Older working versions")[0] ?? "";
  const olderSection = html.split("Older working versions")[1] ?? "";
  assert.match(mainTable, /gpt-5\.6-sol/);
  assert.match(mainTable, /claude-opus-5/);
  assert.doesNotMatch(mainTable, /gpt-5\.5/);
  assert.doesNotMatch(mainTable, /o4-mini/);
  assert.match(olderSection, /gpt-5\.5/);
  assert.match(olderSection, /o4-mini/);
  assert.match(html, /Show 2 older versions/);
});

test("report renders working models and escapes model-controlled HTML", () => {
  const html = modelAuditHtml({
    generated: "now",
    gatewayOnly: true,
    probedCount: 1,
    cachedCount: 0,
    models: [
      model({ id: "claude-opus-4-8", name: "Claude Opus 4.8" }),
      model({ id: "glm-5.3", provider: "baseten", name: "<script>alert(1)</script>", ok: false, error: "denied" }),
    ],
  });

  assert.match(html, /Working models \(latest version per family, by cost\)/);
  assert.match(html, /Claude Opus 4\.8/);
  assert.match(html, />anthropic\/claude-opus-4-8</);
  assert.match(html, /Not working/);
  assert.match(html, /denied/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});
