/**
 * Sandbox Extension - OS-level sandboxing for bash commands and file tools
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux). File tools (read, write, edit) are sandboxed by
 * validating paths against the same config before execution.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "unsandboxedCommands": ["docker", "git push"],
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { ApprovalQueue } from "./ApprovalQueue";
import { createSandboxCommand } from "./commands/sandbox";
import { DEFAULT_CONFIG, loadConfig } from "./config";
import type { SandboxState } from "./data/SandboxState";
import { createSandboxedBashOps } from "./sandbox-ops";
import { createSandboxedBashTool } from "./tools/bash";
import { createSandboxedEditTool } from "./tools/edit";
import { createSandboxedReadTool } from "./tools/read";
import { createSandboxedWriteTool } from "./tools/write";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const cwd = process.cwd();

  const state: SandboxState = {
    enabled: false,
    config: DEFAULT_CONFIG,
    approvalQueue: new ApprovalQueue(),
  };

  // Register tools
  pi.registerTool(createSandboxedBashTool(cwd, state));
  pi.registerTool(createSandboxedEditTool(cwd, state));
  pi.registerTool(createSandboxedReadTool(cwd, state));
  pi.registerTool(createSandboxedWriteTool(cwd, state));

  // Register commands
  pi.registerCommand(
    "sandbox",
    createSandboxCommand(() => state.enabled),
  );

  // Event handlers
  pi.on("user_bash", () => {
    if (!state.enabled) return;
    return { operations: createSandboxedBashOps() };
  });

  pi.on("session_start", async (_event, ctx) => {
    const noSandbox = pi.getFlag("no-sandbox") as boolean;

    if (noSandbox) {
      state.enabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadConfig(ctx.cwd);
    state.config = config;

    if (!config.enabled) {
      state.enabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      state.enabled = false;
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return;
    }

    try {
      const configExt = config as unknown as {
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNestedSandbox?: boolean;
      };

      await SandboxManager.initialize(
        {
          network: config.network,
          filesystem: config.filesystem,
          ignoreViolations: configExt.ignoreViolations,
          enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
        },
        undefined,
        true, // enableLogMonitor - required for annotateStderrWithSandboxFailures
      );

      state.enabled = true;

      const networkCount = config.network?.allowedDomains?.length ?? 0;
      const writeCount = config.filesystem?.allowWrite?.length ?? 0;
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`));
      ctx.ui.notify("Sandbox initialized", "info");
    } catch (err) {
      state.enabled = false;
      ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    if (state.enabled) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  pi.on("before_agent_start", async () => {
    if (!state.enabled) return;

    const { config } = state;
    const lines: string[] = ["# Sandbox Configuration", ""];

    // Filesystem restrictions
    if (config.filesystem) {
      lines.push("## Filesystem Restrictions");
      lines.push("- **Read access:** Allowed everywhere by default, except explicitly denied paths below.");
      if (config.filesystem.denyRead?.length) {
        lines.push(`- **Denied read paths:** ${config.filesystem.denyRead.join(", ")}`);
      }
      if (config.filesystem.allowWrite?.length) {
        lines.push(`- **Allowed write paths:** ${config.filesystem.allowWrite.join(", ")}`);
      }
      if (config.filesystem.denyWrite?.length) {
        lines.push(`- **Denied write paths:** ${config.filesystem.denyWrite.join(", ")}`);
      }
      lines.push("");
    }

    // Network restrictions
    if (config.network) {
      lines.push("## Network Restrictions");
      if (config.network.allowedDomains?.length) {
        lines.push(`- **Allowed domains:** ${config.network.allowedDomains.join(", ")}`);
      }
      if (config.network.deniedDomains?.length) {
        lines.push(`- **Denied domains:** ${config.network.deniedDomains.join(", ")}`);
      }
      lines.push("");
    }

    // Unsandboxed commands
    if (config.unsandboxedCommands?.length) {
      lines.push("## Unsandboxed Commands");
      lines.push(
        `The following commands are pre-allowed auto-bypass sandbox restrictions (exact/prefix match only): ${config.unsandboxedCommands.join(", ")}`,
      );
      lines.push("");
      for (const example of config.unsandboxedCommands) {
        const isPrefix = example.endsWith(" *");
        if (isPrefix) {
          const prefix = example.slice(0, -2);
          lines.push(`Example: \`${prefix} list\` — works (prefix match)`);
          lines.push(`Example: \`${prefix} list | head -10\` — won't work (pipes/shell operators break the match)`);
        } else {
          lines.push(`Example: \`${example}\` — works (exact match)`);
          lines.push(`Example: \`${example} && echo done\` — won't work (shell operators break the match)`);
        }
      }
      lines.push("");
    }

    lines.push("Commands and file operations outside allowed paths will fail with permission errors.");
    lines.push("You can use `unsandboxed` param for a bypass. This will auto-request approval from the user.");

    return {
      message: {
        customType: "sandbox-config",
        content: lines.join("\n"),
        display: false,
      },
    };
  });
}
