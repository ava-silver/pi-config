import assert from "node:assert/strict";
import test from "node:test";

import { sessionCost } from "./session-cost.ts";

test("session cost includes assistant responses and non-message usage such as cache warming", () => {
  const cost = sessionCost([
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
    { type: "message", message: { role: "assistant", usage: { cost: { total: Number.NaN } } } },
    { type: "usage", usage: { cost: { total: 0.5 } } },
    { type: "compaction", usage: { cost: { total: 0.125 } } },
    { type: "custom" },
  ]);
  assert.equal(cost, 0.875);
});
