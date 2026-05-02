import { type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition, createReadTool } from "@mariozechner/pi-coding-agent";

import type { SandboxState } from "../data/SandboxState";
import { isReadAllowed } from "../file-ops";

type ReadParams = {
  path: string;
  offset?: number;
  limit?: number;
  bypassSandbox?: boolean;
};

export function createSandboxedReadTool(cwd: string, state: SandboxState): ToolDefinition {
  const unsafeOriginalRead = createReadTool(cwd);

  return {
    ...unsafeOriginalRead,
    description: `${unsafeOriginalRead.description} Reads in sandbox by default. Set bypassSandbox: true if needed.`,
    parameters: {
      ...unsafeOriginalRead.parameters,
      properties: {
        ...unsafeOriginalRead.parameters.properties,
        bypassSandbox: { type: "boolean" as const, description: "Request approval to run outside the sandbox. Shows a dialog to the user." },
      },
    },
    async execute(
      id: string,
      params: ReadParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ) {
      // If sandbox not enabled or path is auto-approved → run directly
      if (!state.enabled || isReadAllowed(params.path, cwd, state.config)) {
        return unsafeOriginalRead.execute(id, params, signal, onUpdate);
      }

      // If we reached here, the path is NOT allowed in the sandbox.
      if (!params.bypassSandbox) {
        throw new Error(`Sandbox: read denied for "${params.path}"`);
      }

      // Unsandboxed run
      if (!ctx.hasUI) {
        throw new Error("Cannot run unsandboxed read: no UI available for approval");
      }

      const approved = await state.approvalQueue.requestApproval(
        () => ctx.ui.confirm("Unsandboxed Read", `Allow reading without sandbox?\n\n${params.path}`, { signal }),
        signal,
      );

      if (signal?.aborted) {
        throw new Error("aborted");
      }

      if (!approved) {
        throw new Error("User denied permission to read without sandbox");
      }

      return unsafeOriginalRead.execute(id, params, signal, onUpdate);
    },
  };
}
