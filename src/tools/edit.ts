import { type AgentToolUpdateCallback, type EditToolInput, type ExtensionContext, createEditToolDefinition } from "@mariozechner/pi-coding-agent";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";

import type { EditDiffError, EditDiffResult } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js";
import type { SandboxState } from "../data/SandboxState";
import { isReadAllowed, isWriteAllowed } from "../file-ops";

const editDiffModulePath = "../../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js";

async function loadComputeEditsDiff() {
  const mod = await import(editDiffModulePath);
  return mod.computeEditsDiff as (
    path: string,
    edits: Array<{ oldText: string; newText: string }>,
    cwd: string,
  ) => Promise<EditDiffResult | EditDiffError>;
}

type EditParams = EditToolInput & {
  bypassSandbox?: boolean;
};

type EditPreviewState =
  | { kind: "idle"; argsKey: string }
  | { kind: "loading"; argsKey: string }
  | { kind: "ready"; argsKey: string; result: EditDiffResult }
  | { kind: "error"; argsKey: string; message: string }
  | { kind: "skipped"; argsKey: string }
  | { kind: "done"; argsKey: string };

type DryRunOutcome = { kind: "skipped" } | { kind: "ready"; result: EditDiffResult } | { kind: "error"; message: string };

type EditToolRenderState = {
  previewState?: EditPreviewState;
};

function createIdlePreviewState(argsKey: string): EditPreviewState {
  return { kind: "idle", argsKey };
}

function getRenderState(context: { state: unknown }): EditToolRenderState {
  return context.state as EditToolRenderState;
}

function getPreviewState(renderState: EditToolRenderState, argsKey: string): EditPreviewState {
  const existing = renderState.previewState;
  if (existing && existing.argsKey === argsKey) {
    return existing;
  }

  const next = createIdlePreviewState(argsKey);
  renderState.previewState = next;
  return next;
}

async function dryRunEditPreview(args: EditToolInput, cwd: string, sandboxState: SandboxState): Promise<DryRunOutcome> {
  if (sandboxState.enabled && !isReadAllowed(args.path, cwd, sandboxState.config)) {
    return { kind: "skipped" };
  }

  const computeEditsDiff = await loadComputeEditsDiff();
  const preview = await computeEditsDiff(args.path, args.edits, cwd);
  return "error" in preview ? { kind: "error", message: preview.error } : { kind: "ready", result: preview };
}

async function startPreview(
  renderState: EditToolRenderState,
  args: EditToolInput,
  argsKey: string,
  cwd: string,
  sandboxState: SandboxState,
  invalidate: () => void,
): Promise<void> {
  const previewState = renderState.previewState;
  if (!previewState || previewState.argsKey !== argsKey) {
    return;
  }

  const outcome = await dryRunEditPreview(args, cwd, sandboxState);
  const latestState = renderState.previewState;
  if (!latestState || latestState.argsKey !== argsKey || latestState.kind === "done") {
    return;
  }

  switch (outcome.kind) {
    case "skipped":
      renderState.previewState = { kind: "skipped", argsKey };
      break;
    case "error":
      renderState.previewState = { kind: "error", argsKey, message: outcome.message };
      break;
    case "ready":
      renderState.previewState = { kind: "ready", argsKey, result: outcome.result };
      break;
  }

  invalidate();
}

export function createSandboxedEditTool(cwd: string, state: SandboxState) {
  const unsafeOriginalEdit = createEditToolDefinition(cwd);
  type RenderCall = NonNullable<typeof unsafeOriginalEdit.renderCall>;
  type RenderCallArgs = Parameters<RenderCall>[0];
  type RenderCallTheme = Parameters<RenderCall>[1];
  type RenderCallContext = Parameters<RenderCall>[2];
  type RenderResult = NonNullable<typeof unsafeOriginalEdit.renderResult>;
  type RenderResultValue = Parameters<RenderResult>[0];
  type RenderResultOptions = Parameters<RenderResult>[1];
  type RenderResultTheme = Parameters<RenderResult>[2];
  type RenderResultContext = Parameters<RenderResult>[3];
  type RenderResultContentBlock = RenderResultValue["content"][number];

  function getResultText(result: RenderResultValue): string | undefined {
    const text = result.content
      .filter((block): block is Extract<RenderResultContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return text.length > 0 ? text : undefined;
  }

  return {
    ...unsafeOriginalEdit,
    description: `${unsafeOriginalEdit.description} Edits in sandbox by default. Set bypassSandbox: true if needed.`,
    parameters: {
      ...unsafeOriginalEdit.parameters,
      properties: {
        ...unsafeOriginalEdit.parameters.properties,
        bypassSandbox: { type: "boolean" as const, description: "Request approval to run outside the sandbox. Shows a dialog to the user." },
      },
    },
    renderCall(args: RenderCallArgs, theme: RenderCallTheme, context: RenderCallContext) {
      const previewArgs = args as EditToolInput;
      const argsKey = JSON.stringify(previewArgs);
      const renderState = getRenderState(context);
      const previewState = getPreviewState(renderState, argsKey);

      if (context.argsComplete && previewState.kind === "idle") {
        renderState.previewState = { kind: "loading", argsKey };
        void startPreview(renderState, previewArgs, argsKey, cwd, state, context.invalidate);
      }

      const currentPreviewState = renderState.previewState ?? previewState;
      const container = new Container();
      const callComponent = unsafeOriginalEdit.renderCall
        ? unsafeOriginalEdit.renderCall(previewArgs, theme, { ...context, state: {}, lastComponent: undefined })
        : new Text(theme.fg("toolTitle", theme.bold("edit")), 0, 0);
      container.addChild(callComponent);

      switch (currentPreviewState.kind) {
        case "done":
        case "skipped":
        case "idle":
        case "loading":
          return container;
        case "ready": {
          if (!unsafeOriginalEdit.renderResult) {
            return container;
          }

          const previewResult = {
            content: [] as Array<{ type: "text"; text: string }>,
            details: currentPreviewState.result,
          };
          const resultComponent = unsafeOriginalEdit.renderResult(previewResult, { expanded: context.expanded, isPartial: false }, theme, {
            ...context,
            state: {},
            lastComponent: undefined,
            isError: false,
          });
          container.addChild(resultComponent);
          return container;
        }
        case "error": {
          if (!unsafeOriginalEdit.renderResult) {
            return container;
          }

          const previewError: EditDiffError = { error: currentPreviewState.message };
          const resultComponent = unsafeOriginalEdit.renderResult(
            {
              content: [{ type: "text", text: previewError.error }],
              details: undefined,
            },
            { expanded: context.expanded, isPartial: false },
            theme,
            { ...context, state: {}, lastComponent: undefined, isError: true },
          );
          container.addChild(resultComponent);
          return container;
        }
      }
    },
    renderResult(result: RenderResultValue, options: RenderResultOptions, theme: RenderResultTheme, context: RenderResultContext) {
      const renderState = getRenderState(context);
      const previewState = renderState.previewState;

      if (result.details?.diff) {
        return new Container();
      }

      const resultText = getResultText(result);
      if (previewState?.kind === "error" && resultText === previewState.message) {
        return new Container();
      }

      if (previewState) {
        renderState.previewState = { kind: "done", argsKey: previewState.argsKey };
      }

      if (!unsafeOriginalEdit.renderResult) {
        return new Container();
      }

      return unsafeOriginalEdit.renderResult(result, options, theme, { ...context, state: {} });
    },
    async execute(
      id: string,
      params: EditParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext,
    ) {
      // If sandbox not enabled or path is auto-approved → run directly
      if (!state.enabled || isWriteAllowed(params.path, cwd, state.config)) {
        return unsafeOriginalEdit.execute(id, params, signal, onUpdate, ctx);
      }

      // If we reached here, the path is NOT allowed in the sandbox.
      if (!params.bypassSandbox) {
        throw new Error(`Sandbox: edit denied for "${params.path}"`);
      }

      const dryRun = await dryRunEditPreview(params, cwd, state);
      if (dryRun.kind === "error") {
        throw new Error(dryRun.message);
      }

      // Unsandboxed run
      if (!ctx.hasUI) {
        throw new Error("Cannot run unsandboxed edit: no UI available for approval");
      }

      const approved = await state.approvalQueue.requestApproval(
        () => ctx.ui.confirm("Unsandboxed Edit", `Allow editing without sandbox?\n\n${params.path}`, { signal }),
        signal,
      );

      if (signal?.aborted) {
        throw new Error("aborted");
      }

      if (!approved) {
        throw new Error("User denied permission to edit without sandbox");
      }

      return unsafeOriginalEdit.execute(id, params, signal, onUpdate, ctx);
    },
  };
}
