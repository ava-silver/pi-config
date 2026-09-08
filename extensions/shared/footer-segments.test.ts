import assert from "node:assert/strict";
import test from "node:test";

import { getBackgroundCost, registerBackgroundCost } from "./footer-segments.ts";

test("background costs are scoped to their session key", () => {
  registerBackgroundCost("subagents:old-session", 2.5);
  registerBackgroundCost("subagents:new-session", 0.75);

  assert.equal(getBackgroundCost("subagents:new-session"), 0.75);
  assert.equal(getBackgroundCost("subagents:missing-session"), 0);

  registerBackgroundCost("subagents:old-session", null);
  registerBackgroundCost("subagents:new-session", null);
});
