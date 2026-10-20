import assert from "node:assert/strict";
import test from "node:test";

import { inhibitorCommand } from "../caffeinate.ts";

test("macOS uses caffeinate tied to the Pi process", () => {
  assert.deepEqual(inhibitorCommand("darwin", 42), { command: "caffeinate", args: ["-d", "-w", "42"] });
});

test("Linux uses a systemd idle inhibitor that exits with Pi", () => {
  const spec = inhibitorCommand("linux", 42);
  assert.equal(spec?.command, "systemd-inhibit");
  assert.ok(spec?.args.includes("--what=idle"));
  assert.ok(spec?.args.includes("--pid=42"));
});

test("unsupported platforms have no inhibitor", () => {
  assert.equal(inhibitorCommand("win32", 42), undefined);
});
