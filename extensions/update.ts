// `/update` -- background update workflow:
//   1. auto-format extensions (best-effort)
//   2. pre-flight: sync node_modules to bun.lock, then bun run verify
//   3. bun update --latest
//   4. skip post-steps if lockfile unchanged (nothing to do)
//   5. rebuild the Pi binary from the new pins (pi-install)
//   6. post-check: bun run verify
//   7. smoke test: write a unique token to a temp file, ask pi to read it
//      back via --print --no-session, assert the token appears in output
//
// All steps run in a detached background process. Results surface via
// ctx.ui.notify (success/no-change) or pi.sendUserMessage (failure, so
// the agent can fix and re-run). If the agent is mid-task on failure,
// the message is queued as a follow-up.

import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTransientSegment } from "./shared/footer-segments.ts";

const SEGMENT_KEY = "update";
const TIMEOUT_MS = 10 * 60 * 1_000;

export default function updateExtension(pi: ExtensionAPI): void {
  pi.registerCommand("update", {
    description: "Update extensions in the background: format, check, upgrade, smoke test",
    handler: async (_args, ctx) => {
      const stateDir = join(getAgentDir(), "update");
      mkdirSync(stateDir, { recursive: true });

      const resultPath = join(stateDir, "result");
      const logPath = join(stateDir, "update.log");
      const smokeToken = randomBytes(8).toString("hex");
      const smokeFile = `/tmp/pi-smoke-${smokeToken}.txt`;

      try {
        unlinkSync(resultPath);
      } catch {
        /* no stale result */
      }
      try {
        unlinkSync(logPath);
      } catch {
        /* no stale log */
      }

      const extensionsDir = import.meta.dirname;
      const bunBin = "bun";

      if (ctx.mode === "tui") {
        registerTransientSegment(SEGMENT_KEY, {
          text: "updating…",
          bg: "#414559",
          fg: "#838ba7",
        });
      }

      ctx.ui.notify("/update running in background…", "info");

      // Shell script runs entirely detached. Positional args:
      //   $1 = resultPath  $2 = logPath  $3 = extensionsDir
      //   $4 = bunBin      $5 = smokeFile  $6 = smokeToken
      const script = `
status=no_changes
result=$1
log=$2
extensions_dir=$3
bun_bin=$4
smoke_file=$5
smoke_token=$6

finish() {
  printf '%s' "$status" > "$result.tmp.$$"
  mv "$result.tmp.$$" "$result"
  rm -f "$smoke_file"
}
trap finish EXIT HUP INT TERM

# Auto-format (best-effort: fixes trivial whitespace before the check gate)
(cd "$extensions_dir" && "$bun_bin" fmt) >> "$log" 2>&1

# Pre-flight: node_modules can lag bun.lock after a git pull, so sync it first
if ! (cd "$extensions_dir" && "$bun_bin" install --frozen-lockfile && "$bun_bin" run verify) >> "$log" 2>&1; then
  status=preflight_failed
  exit 0
fi

# Snapshot lockfile mtime to detect whether anything actually changed
lockfile="$extensions_dir/bun.lock"
mtime_before=$(stat -f %m "$lockfile" 2>/dev/null || stat -c %Y "$lockfile" 2>/dev/null || echo 0)

# Upgrade all deps including devDependencies, allow major bumps
if ! (cd "$extensions_dir" && "$bun_bin" update --latest) >> "$log" 2>&1; then
  status=update_failed
  exit 0
fi

mtime_after=$(stat -f %m "$lockfile" 2>/dev/null || stat -c %Y "$lockfile" 2>/dev/null || echo 0)

# Nothing changed: skip post-steps entirely
if [ "$mtime_before" = "$mtime_after" ]; then
  status=no_changes
  exit 0
fi

# The pi command is compiled from the pinned package, so rebuild it for the new pins
if ! pi-install >> "$log" 2>&1; then
  status=global_install_failed
  exit 0
fi

# Post-check: make sure the upgrade didn't break anything
if ! (cd "$extensions_dir" && "$bun_bin" run verify) >> "$log" 2>&1; then
  status=postcheck_failed
  exit 0
fi

# Smoke test: write a unique token to a temp file, ask pi to read it back.
# This validates the full round-trip: provider responds, read tool is
# available and executes, result comes back coherently.
printf '%s' "$smoke_token" > "$smoke_file"
smoke_output=$(pi --print --no-session \
  "Read the file $smoke_file and reply with only its exact contents, nothing else." \
  2>>"$log") || true

if printf '%s' "$smoke_output" | grep -qF "$smoke_token"; then
  status=success
else
  status=smoke_failed
  printf 'Smoke test output: %s\n' "$smoke_output" >> "$log"
fi
`;

      const child = spawn(
        "/bin/sh",
        ["-c", script, "pi-update", resultPath, logPath, extensionsDir, bunBin, smokeFile, smokeToken],
        { detached: true, stdio: "ignore" },
      );
      child.once("error", () => {
        if (ctx.mode === "tui") registerTransientSegment(SEGMENT_KEY, null);
        ctx.ui.notify("/update: failed to start background process", "error");
      });
      child.unref();

      const startedAt = Date.now();
      const timer = setInterval(() => {
        // Bail out if the background process takes unreasonably long
        if (Date.now() - startedAt > TIMEOUT_MS) {
          clearInterval(timer);
          if (ctx.mode === "tui") registerTransientSegment(SEGMENT_KEY, null);
          ctx.ui.notify(`/update timed out. See log: ${logPath}`, "warning");
          return;
        }

        let result: string;
        try {
          result = readFileSync(resultPath, "utf8").trim();
        } catch {
          return; // result file not written yet
        }

        clearInterval(timer);
        if (ctx.mode === "tui") registerTransientSegment(SEGMENT_KEY, null);

        if (result === "no_changes") {
          ctx.ui.notify("Nothing to update.", "info");
          return;
        }

        if (result === "success") {
          ctx.ui.notify("Update complete — restart Pi to apply.", "info");
          return;
        }

        // Failure: loop in the agent with the log so it can fix and re-run
        const log = (() => {
          try {
            return readFileSync(logPath, "utf8");
          } catch {
            return "(no log)";
          }
        })();
        const label =
          result === "preflight_failed"
            ? "pre-flight check"
            : result === "postcheck_failed"
              ? "post-update check"
              : result === "global_install_failed"
                ? "global pi install"
                : result === "smoke_failed"
                  ? "smoke test"
                  : result;

        const msg = [
          `/update failed at: ${label}`,
          "```",
          log.slice(-3_000),
          "```",
          "Please fix and re-run /update.",
        ].join("\n");

        if (ctx.isIdle()) {
          pi.sendUserMessage(msg);
        } else {
          pi.sendUserMessage(msg, { deliverAs: "followUp" });
          ctx.ui.notify(`/update failed at ${label} — fix queued as follow-up.`, "warning");
        }
      }, 1_000);

      timer.unref();
    },
  });
}
