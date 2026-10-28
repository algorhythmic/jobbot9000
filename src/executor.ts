/** Operator-hosted executor core. Never registered as a worker tool; mock effects only. */
import { canonicalize, canonicalSha256, verifyReviewBatch, type VerifiedReviewBatch } from "./review-queue.js";
import { loadOdinVerificationConfig, verifyOdinApproval, type OdinVerificationConfig } from "./odin-approval.js";
import { isMockTransport, type TransportAdapter } from "./mock-transport.js";
import type { ExecutionStore, OdinExpectedBinding } from "./execution-types.js";

/** Trusted operator-host startup dependencies, never request-supplied authority.
 * No CLI/MCP send endpoint exists; production trust loading refuses worker-writable keys. */
export interface ExecutorDependencies {
  store: ExecutionStore;
  adapter: TransportAdapter;
  authority: OdinVerificationConfig;
  isSuppressed: (contactId: string, destination: string) => boolean;
  now?: () => number;
}
export interface ExecutionResult {
  status: "dry_run" | "succeeded" | "rejected" | "unknown";
  itemCount: number;
  batchDigest: string;
  executionId?: string;
  receiptId?: string;
}
const denied = (): never => { throw new Error("approved execution denied"); };
export function executionBinding(batch: VerifiedReviewBatch): OdinExpectedBinding {
  const channels = new Set(batch.items.map(item => item.channel));
  // The initial approved envelope is one action. Partial multi-action execution is unsupported.
  if (batch.items.length !== 1 || channels.size !== 1 || batch.items.some(item => item.manualCompletion.length > 0)) return denied();
  return {
    batchDigest: batch.manifest.payloadSha256,
    destinationsDigest: canonicalSha256(batch.items.map(item => ({ id: item.id, channel: item.channel, destination: item.destination }))),
    channel: batch.items[0].channel,
    itemCount: batch.items.length,
  };
}
function clock(deps: ExecutorDependencies): number {
  const now = (deps.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) return denied();
  return now;
}
function checkedBatch(privateDir: string, batchId: string, deps: ExecutorDependencies): VerifiedReviewBatch {
  if (typeof deps.isSuppressed !== "function") return denied();
  const batch = verifyReviewBatch(privateDir, batchId, { now: clock(deps), isSuppressed: deps.isSuppressed });
  executionBinding(batch); return batch;
}
/** No explicit send means no approval consumption, intent write or adapter call. */
export async function executeApprovedBatch(input: { privateDir: string; batchId: string; send?: boolean; approval?: unknown }, deps: ExecutorDependencies): Promise<ExecutionResult> {
  try {
    const adapter = deps.adapter;
    if (!isMockTransport(adapter)) return denied();
    const batch = checkedBatch(input.privateDir, input.batchId, deps), expected = executionBinding(batch);
    const summary = { itemCount: batch.items.length, batchDigest: batch.manifest.payloadSha256 };
    if (input.send !== true) return { status: "dry_run", ...summary };
    // Snapshot all signed data: callers cannot edit the envelope while effects are pending.
    const artifact = JSON.parse(canonicalize(input.approval));
    const approval = verifyOdinApproval(artifact, expected, deps.authority, clock(deps));
    if (deps.store.isRevoked(approval.approval_id)) return denied();
    const executionId = canonicalSha256({ approvalId: approval.approval_id, nonce: approval.nonce, batchDigest: approval.batch_digest });
    const idempotencyKey = canonicalSha256({ batchDigest: approval.batch_digest, itemId: batch.items[0].id });
    deps.store.begin({ executionId, approvalId: approval.approval_id, nonce: approval.nonce, principal: approval.principal, batchDigest: approval.batch_digest, itemId: batch.items[0].id, idempotencyKey, createdAt: clock(deps) });
    // Reserve first; recheck after reservation so revocation, edits or suppression racing it fail closed.
    try {
      const current = checkedBatch(input.privateDir, input.batchId, deps);
      verifyOdinApproval(artifact, executionBinding(current), deps.authority, clock(deps));
      if (deps.store.isRevoked(approval.approval_id)) return denied();
      const intent = deps.store.get(executionId);
      if (!intent || intent.state !== "intent" || intent.idempotencyKey !== idempotencyKey) return denied();
    } catch {
      deps.store.finish(executionId, "rejected", canonicalSha256({ executionId, decision: "preflight_rejected" }), clock(deps));
      return { status: "rejected", executionId, ...summary };
    }
    let receipt;
    try { receipt = await adapter.send({ idempotencyKey }); }
    catch {
      // A thrown call may have taken effect. Never automatically call send again.
      try { deps.store.finish(executionId, "unknown", undefined, clock(deps)); } catch { /* durable intent remains unresolved */ }
      return { status: "unknown", executionId, ...summary };
    }
    try { deps.store.finish(executionId, receipt.state, receipt.receiptId, clock(deps)); }
    catch { return { status: "unknown", executionId, ...summary }; }
    return { status: receipt.state, receiptId: receipt.receiptId, executionId, ...summary };
  } catch { return denied(); }
}
/** Outcome lookup only. No effect retries, even after process interruption or approval expiry. */
export async function reconcileApprovedExecution(executionId: string, deps: ExecutorDependencies): Promise<ExecutionResult> {
  try {
    if (!isMockTransport(deps.adapter)) return denied();
    const record = deps.store.get(executionId);
    if (!record) return denied();
    const summary = { executionId, batchDigest: record.batchDigest, itemCount: 1 };
    if (record.state === "succeeded" || record.state === "rejected") return { status: record.state, ...(record.receiptId ? { receiptId: record.receiptId } : {}), ...summary };
    const receipt = await deps.adapter.lookup(record.idempotencyKey);
    if (!receipt) return { status: "unknown", ...summary };
    deps.store.reconcile(executionId, receipt.state, receipt.receiptId, clock(deps));
    return { status: receipt.state, receiptId: receipt.receiptId, ...summary };
  } catch { return denied(); }
}

/** Odin-host entry point. The trust anchor is loaded from worker-inaccessible
 * private configuration, never from request-supplied key bytes. Deployment must
 * likewise protect this process and its private ledger from worker writes.
 * No worker CLI or MCP endpoint exposes this function.
 */
export async function executeOdinApprovedBatch(
  input: { privateDir: string; batchId: string; send?: boolean; approval?: unknown },
  host: Omit<ExecutorDependencies, "authority"> & { verificationConfigPath: string },
): Promise<ExecutionResult> {
  try {
    const authority = loadOdinVerificationConfig(host.verificationConfigPath);
    // Explicit fields prevent accidental raw authority overrides through spread.
    return await executeApprovedBatch(input, { authority, store: host.store,
      adapter: host.adapter, isSuppressed: host.isSuppressed, now: host.now });
  } catch { return denied(); }
}
