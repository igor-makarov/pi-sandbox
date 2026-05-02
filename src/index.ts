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
import { expandHomePath } from "./file-ops";
import { createSandboxedBashOps } from "./sandbox-ops";
import { createSandboxedBashTool } from "./tools/bash";
import { createSandboxedEditTool } from "./tools/edit";
import { createSandboxedReadTool } from "./tools/read";
import { createSandboxedWriteTool } from "./tools/write";

function formatDisplayPath(path: string, cwd: string): string {
  const originalPath = path;
  path = expandHomePath(path);

  if (path === ".") {
    return `\`${cwd}\``;
  }

  if (path.startsWith("./")) {
    return `\`${cwd + path.slice(1)}\``;
  }

  if (!path.startsWith("/") && path.includes("/")) {
    return `\`${cwd}/${path}\``;
  }

  const isBasenameMatch = !originalPath.startsWith("/") && !originalPath.includes("/") && originalPath !== "~";
  return isBasenameMatch ? `\`${path}\` (basename match)` : `\`${path}\``;
}

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
    sessionId: "",
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
    return { operations: createSandboxedBashOps(state) };
  });

  pi.on("session_start", async (_event, ctx) => {
    state.sessionId = ctx.sessionManager.getSessionId();
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

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!state.enabled) return;

    const { config } = state;
    const lines: string[] = ["# Sandbox Configuration", ""];

    // Filesystem restrictions
    if (config.filesystem) {
      lines.push("## Filesystem Restrictions");
      lines.push("");
      lines.push("### Allowed read paths");
      lines.push("- `/` (entire filesystem readable)");
      lines.push("");

      if (config.filesystem.denyRead?.length) {
        lines.push("### Denied read paths");
        lines.push(...config.filesystem.denyRead.map((path) => `- ${formatDisplayPath(path, ctx.cwd)}`));
        lines.push("");
      }

      if (config.filesystem.allowWrite?.length) {
        lines.push("### Allowed write paths");
        lines.push(...config.filesystem.allowWrite.map((path) => `- ${formatDisplayPath(path, ctx.cwd)}`));
        lines.push("");
      }

      if (config.filesystem.denyWrite?.length) {
        lines.push("### Denied write paths");
        lines.push(...config.filesystem.denyWrite.map((path) => `- ${formatDisplayPath(path, ctx.cwd)}`));
        lines.push("");
      }
    }

    // Network restrictions
    if (config.network) {
      lines.push("## Network Restrictions");
      lines.push("");
      lines.push("### Allowed domains");
      if (config.network.allowedDomains?.length) {
        lines.push(...config.network.allowedDomains.map((domain) => `- ${domain}`));
      } else {
        lines.push("- none");
      }
      lines.push("");

      if (config.network.deniedDomains?.length) {
        lines.push("### Denied domains");
        lines.push(...config.network.deniedDomains.map((domain) => `- ${domain}`));
        lines.push("");
      }
    }

    // Unsandboxed commands
    if (config.unsandboxedCommands?.length) {
      lines.push("## Commands With Auto-escalation");
      lines.push("The following command patterns are pre-allowed to bypass sandbox restrictions:");
      lines.push("");
      for (const pattern of config.unsandboxedCommands) {
        const isPrefix = pattern.endsWith(" *");
        if (isPrefix) {
          const prefix = pattern.slice(0, -2);
          lines.push(`### \`${pattern}\` (prefix match)`);
          lines.push(`- Works: \`${prefix} \"some argument\"\``);
          lines.push(`- Won't work: \`${prefix} | head -10\` (pipes/shell operators break the match)`);
          lines.push(`- Won't work: \`sleep 5 && ${prefix}\` (prepended commands break the match)`);
        } else {
          lines.push(`### \`${pattern}\` (exact match)`);
          lines.push(`- Works: \`${pattern}\``);
          lines.push(`- Won't work: \`${pattern} && echo done\` (shell operators break the match)`);
          lines.push(`- Won't work: \`sleep 5 && ${pattern}\` (prepended commands break the match)`);
        }
        lines.push("");
      }
    }

    lines.push("File operations outside allowed paths, and networking outside allowed domains will fail with permission errors.");
    lines.push("You can use the `bypassSandbox: true` param to request a bypass.");
    lines.push("The tool will show an approval dialog before running outside the sandbox.");

    return {
      message: {
        customType: "sandbox-config",
        content: lines.join("\n"),
        display: false,
      },
    };
  });
}
