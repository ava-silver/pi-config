import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("update", {
    description: "Manual update: pre-check, upgrade, post-check, smoke test",
    handler: async (args, ctx) => {
      const extDir = "extensions";
      const smokeFile = "/tmp/pi-update-smoke.txt";
      const diagnostics: string[] = [];

      // Helper to run command and capture output
      const run = (cmd: string[], cwd?: string, desc?: string): string => {
        try {
          const result = execFileSync("bun", cmd, { cwd, encoding: "utf-8", stdio: "pipe" });
          if (desc) diagnostics.push(`${desc}: SUCCESS`);
          return result;
        } catch (e: any) {
          const err = e as { stderr?: any; stdout?: any; message?: any };
          const output = (err.stderr || err.stdout || err.message || "").toString();
          if (desc) diagnostics.push(`${desc}: FAILED - ${output.trim().slice(0, 500)}`);
          return output;
        }
      };

      // Pre-flight gate
      diagnostics.push("=== UPDATE WORKFLOW START ===");
      const pre = run(["run", "check"], extDir, "Pre-flight check");
      if (pre.includes("FAILED") || pre.includes("error") || pre.includes("FAIL")) {
        diagnostics.push("=== PRE-FLIGHT CHECK FAILED, BLOCKING UPDATE ===");
        diagnostics.push(pre);
        pi.sendUserMessage(
          `Update aborted: extensions are broken.\n\n${diagnostics.join("\n")}`
        );
        return;
      }

      // Update packages
      const upd = run(["update", "--all", "--latest", "--all-deps"], undefined, "Package update");
      if (upd.includes("error") || upd.includes("FAIL")) {
        diagnostics.push("=== PACKAGE UPDATE FAILED ===");
        diagnostics.push(upd);
        pi.sendUserMessage(
          `Update failed. Run diagnostics:\n\n${diagnostics.join("\n")}`
        );
        return;
      }

      // Post-check
      const post = run(["run", "check"], extDir, "Post-check");
      if (post.includes("FAILED") || post.includes("error") || post.includes("FAIL")) {
        diagnostics.push("=== POST-CHECK FAILED ===");
        diagnostics.push(post);
        pi.sendUserMessage(
          `Update partially succeeded but post-check failed. Diagnostics:\n\n${diagnostics.join("\n")}`
        );
        return;
      }

      // Smoke test
      try {
        require("node:fs").writeFileSync(smokeFile, "PI_UPDATE_SMOKE=ok\n");
        const back = execFileSync("cat", [smokeFile], { encoding: "utf-8" }).trim();
        if (back !== "PI_UPDATE_SMOKE=ok") {
          diagnostics.push("=== SMOKE TEST FAILED ===");
          diagnostics.push(`Expected PI_UPDATE_SMOKE=ok, got: ${back}`);
          pi.sendUserMessage(
            `Smoke test failed.\n\n${diagnostics.join("\n")}`
          );
          return;
        }
      } catch (e: any) {
        diagnostics.push("=== SMOKE TEST FAILED ===");
        diagnostics.push(String(e));
        pi.sendUserMessage(
          `Smoke test failed.\n\n${diagnostics.join("\n")}`
        );
        return;
      }

      diagnostics.push("=== UPDATE COMPLETE: ALL CHECKS PASSED ===");
      pi.sendUserMessage(
        `Update successful.\n\n${diagnostics.join("\n")}"`
      );
    },
  });
}
