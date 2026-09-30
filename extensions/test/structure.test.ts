import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");

async function findNestedManifests(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "trajectory") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findNestedManifests(path)));
    } else if (directory !== ROOT && (entry.name === "package.json" || entry.name === "bun.lock")) {
      found.push(relative(ROOT, path));
    }
  }
  return found;
}

test("extensions use the root manifest and lockfile", async () => {
  assert.deepEqual(await findNestedManifests(ROOT), []);
});

test("auto-discovered root contains no tests", async () => {
  const rootFiles = await readdir(ROOT, { withFileTypes: true });
  assert.deepEqual(
    rootFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts")).map((entry) => entry.name),
    [],
  );
});

test("Pi SDK packages stay aligned", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    packageManager?: string;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.match(manifest.packageManager ?? "", /^bun@\d+\.\d+\.\d+$/);

  const packages = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const;
  const versions = packages.map((name) => manifest.devDependencies?.[name]);
  assert.equal(new Set(versions).size, 1);
  const devVersion = versions[0] ?? "";
  assert.match(devVersion, /^\d+\.\d+\.\d+$/);
  for (const name of packages) assert.equal(manifest.peerDependencies?.[name], "*");

  // Resolve the globally installed pi package without spawning pi: scan every
  // `pi` binary on PATH for an embedded module path (present in shell wrappers
  // but absent from compiled bun shims), then read its package.json.
  const dirs = (process.env["PATH"] ?? "").split(":");
  const piBins = dirs
    .map((d) => join(d, "pi"))
    .filter((p) => {
      try {
        return !!statSync(p).isFile();
      } catch {
        return false;
      }
    });
  assert.ok(piBins.length > 0, "pi binary not found on PATH");
  let globalPkgPath: string | undefined;
  for (const piBin of piBins) {
    const wrapper = readFileSync(piBin, "utf8");
    const match = wrapper
      .match(/[\w${}/.~-]+node_modules\/@earendil-works\/pi-coding-agent/)?.[0]
      ?.replace("$HOME", homedir());
    if (match) {
      globalPkgPath = match;
      break;
    }
  }
  assert.ok(globalPkgPath, "could not resolve pi package path from any wrapper script on PATH");
  const { version: installedVersion } = JSON.parse(readFileSync(`${globalPkgPath}/package.json`, "utf8")) as {
    version: string;
  };
  assert.equal(
    devVersion,
    installedVersion,
    `devDependencies pin pi@${devVersion} but the installed binary is pi@${installedVersion} -- update devDependencies and run \`bun install\` in extensions/`,
  );
});
