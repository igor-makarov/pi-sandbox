import { type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition, createReadTool } from "@mariozechner/pi-coding-agent";

import type { SandboxState } from "../data/SandboxState";
import { isReadAllowed } from "../file-ops";

type ReadParams = {
  path: string;
  offset?: number;
  limit?: number;
  unsandboxed?: boolean;
};

export function createSandboxedReadTool(cwd: string, state: SandboxState): ToolDefinition {
  const unsafeOriginalRead = createReadTool(cwd);

  return {
    ...unsafeOriginalRead,
    description: `${unsafeOriginalRead.description} Reads in sandbox by default. Escalate using unsandboxed: true if needed.`,
    parameters: {
      ...unsafeOriginalRead.parameters,
      properties: {
        ...unsafeOriginalRead.parameters.properties,
        unsandboxed: { type: "boolean" as const, description: "Show UI to user to bypass sandbox restrictions" },
      },
    },
    async execute(
      id: string,
      params: ReadParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ) {
      // If sandbox not enabled → run directly
      if (!state.enabled) {
        return unsafeOriginalRead.execute(id, params, signal, onUpdate);
      }

      // Default: check if read is allowed
      if (!params.unsandboxed) {
        if (!isReadAllowed(params.path, cwd, state.config)) {
          throw new Error(`Sandbox: read denied for "${params.path}"`);
        }
        return unsafeOriginalRead.execute(id, params, signal, onUpdate);
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
