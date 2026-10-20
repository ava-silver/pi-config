import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { parseLoginctlPresence, waitForTasks } from "./index.ts";

test("shutdown wait is bounded for unfinished speech", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const waited = waitForTasks([new Promise<void>(() => {})], 10);
    mock.timers.tick(10);
    await waited;
  } finally {
    mock.timers.reset();
  }
});

test("loginctl presence requires an unlocked, non-idle session", () => {
  assert.equal(parseLoginctlPresence("LockedHint=no\nIdleHint=no\n"), true);
  assert.equal(parseLoginctlPresence("LockedHint=yes\nIdleHint=no\n"), false);
  assert.equal(parseLoginctlPresence("LockedHint=no\nIdleHint=yes\n"), false);
  assert.equal(parseLoginctlPresence(""), undefined);
});
