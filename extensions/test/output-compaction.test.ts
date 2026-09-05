import assert from "node:assert/strict";
import test from "node:test";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { restoreExpandKeyHint } from "../output-compaction.ts";

const runtime = { sliceByColumn, truncateToWidth, visibleWidth };

test("restored expand hints do not exceed the render width", () => {
  const width = 143;
  const hint = "... (19 earlier lines, to expand)";
  const line = `\x1b[48;2;35;38;52m ${hint}${" ".repeat(width - visibleWidth(hint) - 1)}`;

  const restored = restoreExpandKeyHint(line, width, runtime);

  assert.match(restored, /ctrl\+o/);
  assert.equal(visibleWidth(restored), width);
});
