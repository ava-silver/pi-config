import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { PythonRepl } from "./runtime.ts";

test("Python REPL preserves state and returns the final expression", async (t) => {
  const repl = new PythonRepl();
  t.after(() => repl.close());

  const assigned = await repl.execute("value = 40");
  assert.equal(assigned.result, null);

  const result = await repl.execute("value + 2");
  assert.equal(result.result, "42");
  assert.equal(result.error, null);
});

test("Python REPL captures output and exceptions", async (t) => {
  const repl = new PythonRepl();
  t.after(() => repl.close());

  const result = await repl.execute('print("before")\nraise ValueError("bad value")');

  assert.equal(result.stdout, "before\n");
  assert.match(result.error ?? "", /ValueError: bad value/);
});

test("clearing removes variables but keeps the temporary environment", async (t) => {
  const repl = new PythonRepl();
  t.after(() => repl.close());
  await repl.execute("value = 42");
  const environmentPath = repl.environmentPath;

  await repl.clear();
  const result = await repl.execute("value");

  assert.equal(repl.environmentPath, environmentPath);
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
