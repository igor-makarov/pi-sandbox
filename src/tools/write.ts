import { type AgentToolUpdateCallback, type ExtensionContext, type ToolDefinition, createWriteTool } from "@mariozechner/pi-coding-agent";

import type { SandboxState } from "../data/SandboxState";
import { isWriteAllowed } from "../file-ops";

type WriteParams = {
  path: string;
  content: string;
  bypassSandbox?: boolean;
};

export function createSandboxedWriteTool(cwd: string, state: SandboxState): ToolDefinition {
  const unsafeOriginalWrite = createWriteTool(cwd);

  return {
    ...unsafeOriginalWrite,
    description: `${unsafeOriginalWrite.description} Writes in sandbox by default. Set bypassSandbox: true if needed.`,
    parameters: {
      ...unsafeOriginalWrite.parameters,
      properties: {
        ...unsafeOriginalWrite.parameters.properties,
        bypassSandbox: { type: "boolean" as const, description: "Request approval to run outside the sandbox. Shows a dialog to the user." },
      },
    },
    async execute(
      id: string,
      params: WriteParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ) {
      // If sandbox not enabled or path is auto-approved → run directly
      if (!state.enabled || isWriteAllowed(params.path, cwd, state.config)) {
        return unsafeOriginalWrite.execute(id, params, signal, onUpdate);
      }

      // If we reached here, the path is NOT allowed in the sandbox.
      if (!params.bypassSandbox) {
        throw new Error(`Sandbox: write denied for "${params.path}"`);
      }

      // Unsandboxed run
      if (!ctx.hasUI) {
        throw new Error("Cannot run unsandboxed write: no UI available for approval");
      }

      const approved = await state.approvalQueue.requestApproval(
        () => ctx.ui.confirm("Unsandboxed Write", `Allow writing without sandbox?\n\n${params.path}`, { signal }),
        signal,
      );

      if (signal?.aborted) {
        throw new Error("aborted");
      }

      if (!approved) {
        throw new Error("User denied permission to write without sandbox");
      }

      return unsafeOriginalWrite.execute(id, params, signal, onUpdate);
    },
  };
}
