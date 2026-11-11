import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import { createFooterSegmentStore, registerBackgroundCost, registerTransientSegment } from "./footer-segments.ts";

test("footer store receives segments and costs emitted on the shared event bus", () => {
  const events = createEventBus();
  let renders = 0;
  const store = createFooterSegmentStore(events, () => renders++);

  registerBackgroundCost(events, "subagents:old-session", 2.5);
  registerBackgroundCost(events, "subagents:new-session", 0.75);
  registerTransientSegment(events, "subagents", { text: "4 running", bg: "#81c8be", fg: "#1e2030" });

  assert.equal(store.backgroundCost("subagents:new-session"), 0.75);
  assert.equal(store.backgroundCost("subagents:missing-session"), 0);
  assert.equal(store.segments.get("subagents")?.text, "4 running");
  assert.equal(renders, 3);

  registerBackgroundCost(events, "subagents:new-session", null);
  registerTransientSegment(events, "subagents", null);
  assert.equal(store.backgroundCost("subagents:new-session"), 0);
  assert.equal(store.segments.has("subagents"), false);
  store.dispose();
});
