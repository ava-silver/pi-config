import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRepositoryPrompt,
  detectCi,
  parseGitHubRemotes,
  parseRepositoryRemote,
  readRepositoryCache,
  selectGitHubRemote,
  writeRepositoryContext,
  type RepositoryContext,
} from "../repository-context.ts";

const context: RepositoryContext = {
  url: "https://github.com/DataDog/example",
  organization: "DataDog",
  repository: "example",
  visibility: "public",
  ci: [
    {
      provider: "github",
      project: "DataDog/example",
      url: "https://github.com/DataDog/example/actions",
    },
    {
      provider: "gitlab",
      project: "DataDog/example",
      url: "https://gitlab.ddbuild.io/DataDog/example",
    },
  ],
};

test("parses HTTPS and SSH GitHub remotes", () => {
  assert.deepEqual(parseRepositoryRemote("https://github.com/DataDog/example.git"), {
    key: "https://github.com/DataDog/example",
    context: { ...context, visibility: "unknown", ci: [] },
  });
  assert.equal(parseRepositoryRemote("git@ddoghq.github.com:ddoghq/example.git")?.context.organization, "ddoghq");
  assert.equal(parseRepositoryRemote("git@gitlab.ddbuild.io:DataDog/example.git"), undefined);
});

test("uses origin instead of another GitHub remote", () => {
  const remotes = parseGitHubRemotes(`remote.datadog.url https://github.com/DataDog/dd-source.git
remote.origin.url git@github.com:ddoghq/dd-source.git`);
  const remote = selectGitHubRemote(remotes);
  assert.equal(remote?.name, "origin");
  assert.equal(remote?.context.url, "https://github.com/ddoghq/dd-source");
});

test("writes and reads editable repository metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "repository-context-"));
  const cachePath = join(root, "state", "repository-context.json");
  try {
    assert.deepEqual(readRepositoryCache(cachePath), {});
    writeRepositoryContext(context.url, context, cachePath);
    assert.deepEqual(readRepositoryCache(cachePath)[context.url], {
      visibility: context.visibility,
      ci: context.ci,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid repository metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "repository-context-invalid-"));
  const cachePath = join(root, "repository-context.json");
  try {
    writeFileSync(cachePath, '{"https://github.com/DataDog/example":{"visibility":"public"}}\n');
    assert.throws(() => readRepositoryCache(cachePath), /repository entries are invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects GitHub Actions and GitLab CI configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "repository-ci-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".gitlab-ci.yml"), "include: []\n");
    assert.deepEqual(detectCi(root), ["github", "gitlab"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("builds GitHub repository and GitLab mirror guidance", () => {
  const prompt = buildRepositoryPrompt(context);
  assert.match(prompt, /GitHub repository: DataDog\/example/);
  assert.match(prompt, /Visibility: public/);
  assert.match(prompt, /GitHub Actions: DataDog\/example/);
  assert.match(prompt, /GitLab CI: DataDog\/example/);
  assert.match(prompt, /authentication for DataDog/);
  assert.match(prompt, /--repo DataDog\/example/);
});
