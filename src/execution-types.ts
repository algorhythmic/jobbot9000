// Option A contracts. Production code contains no signing capability.
export interface OdinApprovalPayload {
  approval_id: string;
  batch_digest: string;
  principal: string;
  channel: string;
  destinations_digest: string;
  item_count: number;
  issued_at: number;
  expires_at: number;
  nonce: string;
}
export interface OdinApprovalArtifact { issuer: "odin"; key_id: string; payload: OdinApprovalPayload; signature: string }
export interface OdinExpectedBinding { batchDigest: string; destinationsDigest: string; channel: string; itemCount: number }
export interface ExecutionIntent {
  executionId: string; approvalId: string; nonce: string; batchDigest: string; principal: string;
  itemId: string; idempotencyKey: string; createdAt: number;
}
export type ExecutionState = "intent" | "succeeded" | "rejected" | "unknown";
export interface ExecutionRecord extends ExecutionIntent {
  state: ExecutionState; receiptId?: string; updatedAt: number;
}
export interface ExecutionStore {
  begin(intent: ExecutionIntent): void;
  finish(executionId: string, state: "succeeded" | "rejected" | "unknown", receiptId: string | undefined, now: number): void;
  get(executionId: string): ExecutionRecord | undefined;
  reconcile(executionId: string, state: "succeeded" | "rejected", receiptId: string, now: number): void;
  revoke(approvalId: string, now: number): void;
  isRevoked(approvalId: string): boolean;
}
