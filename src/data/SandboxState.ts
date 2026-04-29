import type { ApprovalQueue } from "../ApprovalQueue";
import type { SandboxConfig } from "../types";

export interface SandboxState {
  enabled: boolean;
  config: SandboxConfig;
  approvalQueue: ApprovalQueue;
  sessionId: string;
}
