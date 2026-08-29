import assert from "node:assert/strict";
import * as fs from "node:fs";
import test, { after, before } from "node:test";
import { PythonRepl } from "./runtime.ts";

// Tests that don't require an isolated environment share one REPL to avoid
// paying the ~1.8s venv-creation cost four times.
let shared: PythonRepl;
before(async () => {
  shared = new PythonRepl();
});
after(async () => {
  await shared.close();
});

test("Python REPL preserves state and returns the final expression", async () => {
  const assigned = await shared.execute("value = 40");
  assert.equal(assigned.result, null);

  const result = await shared.execute("value + 2");
  assert.equal(result.result, "42");
  assert.equal(result.error, null);
});

test("Python REPL captures output and exceptions", async () => {
  const result = await shared.execute('print("before")\nraise ValueError("bad value")');

  assert.equal(result.stdout, "before\n");
  assert.match(result.error ?? "", /ValueError: bad value/);
});

test("clearing removes variables but keeps the temporary environment", async () => {
  await shared.execute("value = 42");
  const environmentPath = shared.environmentPath;

  await shared.clear();
  const result = await shared.execute("value");

  assert.equal(shared.environmentPath, environmentPath);
  assert.match(result.error ?? "", /NameError/);
});

test("closing removes the temporary virtual environment", async () => {
  const repl = new PythonRepl();
  await repl.execute("import json\njson.dumps({'ready': True})");
  const environmentPath = repl.environmentPath;
  assert.ok(environmentPath);
  assert.equal(fs.existsSync(environmentPath), true);

  await repl.close();

  assert.equal(fs.existsSync(environmentPath), false);
});
