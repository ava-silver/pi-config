import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./concurrency.ts";

test("mapWithConcurrency caps concurrency and preserves order", async () => {
  let active = 0;
  let maxActive = 0;
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const results = await mapWithConcurrency(items, 4, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, (items.length - item) * 2));
    active--;
    return item;
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(results, items);
});
