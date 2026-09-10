import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

for (const scanExitCode of [200, 205]) {
  test(`redacts an escaped secret when Kingfisher exits with ${scanExitCode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-redaction-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "session.jsonl");
    const secret = "0123456789abcdef0123456789abcdef";
    const content = `${JSON.stringify({
      type: "message",
      message: { content: `{"api_key": "${secret}", "duplicate": "${secret}"}` },
    })}\n`;
    await writeFile(sessionFile, content);

    const starts = [content.indexOf(secret), content.lastIndexOf(secret)];
    const findings = starts.map((start) => ({
      startLine: 1,
      startColumn: start + 1,
      endColumn: start + secret.length + 1,
    }));
    const sarif = JSON.stringify({
      runs: [
        {
          results: findings.map((region) => ({
            locations: [{ physicalLocation: { region: { ...region, snippet: { text: secret } } } }],
          })),
        },
      ],
    });
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const commands: string[] = [];
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (name === "session_start") sessionStart = handler;
      },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        commands.push([command, ...args].join(" "));
        if (args[0] === "--version") return { code: 0, stdout: "kingfisher", stderr: "" };
        return {
          code: scanExitCode,
          stdout: `${sarif}\n`,
          stderr: "",
        };
      },
    };
    extension(pi as never);

    const notifications: string[] = [];
    await sessionStart?.(
      {},
      {
        hasUI: true,
        ui: { notify: (message: string) => notifications.push(message) },
        sessionManager: { getSessionFile: () => sessionFile },
      },
    );

    const result = await readFile(sessionFile, "utf8");
    assert.equal(Buffer.byteLength(result), Buffer.byteLength(content));
    assert.equal(result.includes(secret), false);
    assert.equal(result.split("*".repeat(secret.length)).length - 1, 2);
    assert.doesNotThrow(() => JSON.parse(result));
    assert.deepEqual(notifications, ["Redacted 2 secrets from this session."]);
    assert.deepEqual(commands.slice(0, 2), [
      "kingfisher --version",
      `kingfisher scan ${sessionFile} --rules-path ${import.meta.dirname}/rules.yaml --git-history none --validation-filter actionable --no-dedup --format sarif --no-update-check`,
    ]);
  });
}

test("uses Kingfisher's snippet when its range includes an escaped quote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-redaction-"));
  temporaryDirectories.push(directory);
  const sessionFile = join(directory, "session.jsonl");
  const secret = "0123456789abcdef0123456789abcdef";
  const content = `${JSON.stringify({
    type: "message",
    message: { content: `DD_API_KEY=\\"${secret}\\"` },
  })}\n`;
  await writeFile(sessionFile, content);

  const secretStart = content.indexOf(secret);
  const sarif = JSON.stringify({
    runs: [
      {
        results: [
          {
            locations: [
              {
                physicalLocation: {
                  region: {
                    startLine: 1,
                    startColumn: secretStart,
                    endColumn: secretStart + secret.length - 1,
                    snippet: { text: secret },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      if (name === "session_start") sessionStart = handler;
    },
    registerCommand() {},
    async exec(_command: string, args: string[]) {
      if (args[0] === "--version") return { code: 0, stdout: "kingfisher", stderr: "" };
      return { code: 200, stdout: sarif, stderr: "" };
    },
  };
  extension(pi as never);

  await sessionStart?.(
    {},
    {
      hasUI: false,
      sessionManager: { getSessionFile: () => sessionFile },
    },
  );

  const result = await readFile(sessionFile, "utf8");
  assert.equal(result.includes(secret), false);
  assert.doesNotThrow(() => JSON.parse(result));
});
