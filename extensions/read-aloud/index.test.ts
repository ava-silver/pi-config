import test, { mock } from "node:test";

import { waitForTasks } from "./index.ts";

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
