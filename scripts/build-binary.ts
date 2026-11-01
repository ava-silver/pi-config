#!/usr/bin/env bun
// Build Pi binaries from the globally installed @earendil-works/pi-coding-agent package.
//
//   pi-dev  bytecode binary; extensions load from disk (jiti), so /reload picks up edits.
//   pi      bytecode binary with stable extensions compiled in; edits need a rebuild.
//
// usage: bun build-binary.ts [--out <dir>] [--only pi|pi-dev] [--if-stale]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const AGENT = process.env.PI_CODING_AGENT_DIR ?? join(HOME, ".pi/agent");
const GLOBAL_MODULES = join(HOME, ".bun/install/global/node_modules");
const PKG = join(GLOBAL_MODULES, "@earendil-works/pi-coding-agent");
const EXT = join(AGENT, "extensions");

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const OUT = arg("--out") ?? join(HOME, ".pi/binary");
const only = arg("--only");

type Candidate = { id: string; rel: string };

const disabledExtensions = async (): Promise<Set<string>> => {
  const settings = await Bun.file(join(AGENT, "settings.json")).json();
  return new Set<string>(
    ((settings.extensions ?? []) as string[]).filter((e) => e.startsWith("-")).map((e) => e.slice(1)),
  );
};

const discover = (): Candidate[] =>
  readdirSync(EXT, { withFileTypes: true }).flatMap((d): Candidate[] => {
    if (d.isFile() && d.name.endsWith(".ts") && !d.name.endsWith(".test.ts")) {
      return [{ id: d.name, rel: `extensions/${d.name}` }];
    }
    return d.isDirectory() && existsSync(join(EXT, d.name, "index.ts"))
      ? [{ id: d.name, rel: `extensions/${d.name}/index.ts` }]
      : [];
  });

const entrySource = (compiledIn: Candidate[]) =>
  [
    `import "${PKG}/dist/bun/sandbox-env-setup.js";`,
    `import "${PKG}/dist/bun/runtime-setup.js";`,
    `import { setupCli } from "${PKG}/dist/cli/setup.js";`,
    `import { main } from "${PKG}/dist/main.js";`,
    `import { SettingsManager } from "${PKG}/dist/core/settings-manager.js";`,
    ...compiledIn.map((c, i) => `import e${i} from "${AGENT}/${c.rel}";`),
    // Disk discovery would load these a second time; exclude them like a "-extensions/..." entry in settings.json.
    `const excluded = ${JSON.stringify(compiledIn.map((c) => `-${c.rel}`))};`,
    `const getGlobalSettings = SettingsManager.prototype.getGlobalSettings;`,
    `SettingsManager.prototype.getGlobalSettings = function () {`,
    `  const s = getGlobalSettings.call(this);`,
    `  return { ...s, extensions: [...(s.extensions ?? []), ...excluded] };`,
    `};`,
    `setupCli();`,
    // -ne means "no extensions": honor it for the compiled-in ones too.
    `const args = process.argv.slice(2);`,
    `const noExtensions = args.includes("-ne") || args.includes("--no-extensions");`,
    `main(args, { extensionFactories: noExtensions ? [] : [${compiledIn.map((_, i) => `e${i}`).join(", ")}] });`,
  ].join("\n");

// Compiled-in extensions share the binary's copy of Pi's packages, as jiti's virtual modules do for disk extensions.
const hostModules: Record<string, string> = {
  "@earendil-works/pi-coding-agent": `${PKG}/dist/index.js`,
  "@earendil-works/pi-ai": "@earendil-works/pi-ai/compat",
};
const hostPlugin: Bun.BunPlugin = {
  name: "host-modules",
  setup: (b) => {
    b.onResolve({ filter: /^(@earendil-works\/pi-(coding-agent|tui|agent-core|ai)(\/.*)?|typebox(\/.*)?)$/ }, (a) =>
      a.importer.startsWith(EXT) ? { path: Bun.resolveSync(hostModules[a.path] ?? a.path, PKG) } : undefined,
    );
  },
};

const build = async (name: string, compiledIn: Candidate[]) => {
  const entry = join(tmpdir(), `pi-entry-${name}.ts`);
  writeFileSync(entry, entrySource(compiledIn));
  const result = await Bun.build({
    entrypoints: [entry, `${PKG}/dist/utils/image-resize-worker.js`, `${PKG}/dist/extensions/codemode/worker.js`],
    compile: { outfile: join(OUT, `${name}.tmp`), autoloadBunfig: false, autoloadDotenv: false },
    bytecode: true,
    format: "esm",
    plugins: [hostPlugin],
  });
  if (!result.success) {
    result.logs.forEach((l) => console.error(String(l)));
    process.exit(1);
  }
  // Rename over the old binary: a running Pi keeps its old inode, which an in-place write would corrupt.
  renameSync(join(OUT, `${name}.tmp`), join(OUT, name));
  console.log(`built ${join(OUT, name)} (${compiledIn.length} extensions compiled in)`);
};

// Layout the compiled binary expects next to itself (see config.js `isBunBinary` paths).
const copyAssets = () => {
  const copy = (from: string, to: string) => cpSync(from, join(OUT, to), { recursive: true });
  ["package.json", "README.md", "CHANGELOG.md", "docs", "examples"].forEach((f) => copy(join(PKG, f), f));
  copy(join(PKG, "dist/modes/interactive/theme"), "theme");
  copy(join(PKG, "dist/modes/interactive/assets"), "assets");
  copy(join(PKG, "dist/core/export-html"), "export-html");
  copy(join(GLOBAL_MODULES, "@silvia-odwyer/photon-node/photon_rs_bg.wasm"), "photon_rs_bg.wasm");
};

// Fingerprint of everything a binary is built from: Pi version, this script, settings, and extension sources.
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.name === "node_modules" || d.name.startsWith(".")
      ? []
      : d.isDirectory()
        ? walk(join(dir, d.name))
        : /\.(ts|json|lock)$/.test(d.name)
          ? [join(dir, d.name)]
          : [],
  );
const fingerprint = () =>
  String(
    Bun.hash(
      [join(PKG, "package.json"), import.meta.path, join(AGENT, "settings.json"), ...walk(EXT).sort()]
        .map((f) => `${f}\0${readFileSync(f, "utf8")}`)
        .join("\0"),
    ),
  );
const stampPath = join(OUT, ".fingerprint");
const current = fingerprint();
if (process.argv.includes("--if-stale") && existsSync(stampPath) && readFileSync(stampPath, "utf8") === current) {
  console.log("binaries up to date");
  process.exit(0);
}

// Start a binary in RPC mode and poll its command names until they stop changing (extensions can register late,
// e.g. web-search loads pi-web-access in the background). Pi reports extension load errors on stderr.
const rpcCommands = async (bin: string): Promise<{ names: string[]; stderr: string }> => {
  const proc = Bun.spawn([bin, "--offline", "--mode", "rpc", "--no-session"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: tmpdir(),
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const snapshots: string[][] = [];
  let buffer = "";
  const readSnapshots = () => {
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach((line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "response" && msg.command === "get_commands") {
          snapshots.push(msg.data.commands.map((c: { name: string }) => c.name).sort());
        }
      } catch {
        // Not a JSON response line.
      }
    });
  };
  const settled = () => {
    const last = snapshots.slice(-3);
    return last.length === 3 && last.every((names) => names.join() === last[0]?.join());
  };
  const deadline = Date.now() + 60_000;
  while (!settled() && Date.now() < deadline) {
    proc.stdin.write('{"type":"get_commands"}\n');
    proc.stdin.flush();
    const chunk = await Promise.race([reader.read(), Bun.sleep(700).then(() => undefined)]);
    if (chunk?.value) buffer += decoder.decode(chunk.value);
    readSnapshots();
    if (chunk?.done) break;
    await Bun.sleep(300);
  }
  proc.kill();
  return { names: snapshots.at(-1) ?? [], stderr: await new Response(proc.stderr).text() };
};

// pi must expose exactly what pi-dev discovers from disk: a missing extension or a double load both show up.
const verify = async () => {
  const [pi, dev] = await Promise.all([rpcCommands(join(OUT, "pi")), rpcCommands(join(OUT, "pi-dev"))]);
  const sorted = (xs: string[]) => [...xs].sort().join(",");
  const problems = [
    ...(pi.names.length === 0 ? ["pi returned no commands"] : []),
    ...(/Failed to load extension/.test(pi.stderr) ? [`pi reported load errors:\n${pi.stderr}`] : []),
    ...(sorted(pi.names) !== sorted(dev.names) ? [`commands differ:\n pi:     ${sorted(pi.names)}\n pi-dev: ${sorted(dev.names)}`] : []),
  ];
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`verified: pi and pi-dev expose the same ${pi.names.length} commands`);
};

mkdirSync(OUT, { recursive: true });
copyAssets();

const disabled = await disabledExtensions();
const compiledIn = discover().filter((c) => !disabled.has(c.rel));

if (only !== "pi") await build("pi-dev", []);
if (only !== "pi-dev") {
  console.log("compiling in:", compiledIn.map((c) => c.id).join(", "));
  await build("pi", compiledIn);
}

if (only === undefined) await verify();
writeFileSync(stampPath, current);
