/**
 * Approval RECORD contract only. This module has no transport or minting authority.
 * All local records are untrusted: workers and the operator currently share an OS
 * identity. A file, environment variable, actor label, or payload hash cannot prove
 * that an operator approved anything. Do not turn this into a bearer-file scheme.
 */
export const MAX_APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ApprovalDestination {
  itemId: string;
  channel: string;
  destination: string;
}

export interface ApprovalAttachment {
  itemId: string;
  path: string;
  sha256: string;
}

export interface ApprovalBinding {
  batchId: string;
  revision: number;
  payloadSha256: string;
  destinations: ApprovalDestination[];
  attachments: ApprovalAttachment[];
  actionCount: number;
}

export interface ApprovalRecord extends ApprovalBinding {
  schemaVersion: 1;
  id: string;
  actor: string;
  createdAt: string;
  expiresAt: string;
  state: "approved" | "revoked" | "consumed";
}

export type ApprovalDenialReason =
  | "malformed_approval"
  | "malformed_binding"
  | "revoked"
  | "consumed"
  | "expired"
  | "not_yet_valid"
  | "approval_ttl_exceeded"
  | "binding_mismatch"
  | "operator_boundary_unavailable";

export interface ApprovalDenial {
  ok: false;
  reason: ApprovalDenialReason;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function isBinding(value: unknown): value is ApprovalBinding {
  if (!object(value) || !identifier(value.batchId) || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 1 || !digest(value.payloadSha256)
      || !Number.isSafeInteger(value.actionCount) || (value.actionCount as number) < 1
      || !Array.isArray(value.destinations) || value.destinations.length !== value.actionCount
      || value.destinations.length > 100 || !Array.isArray(value.attachments) || value.attachments.length > 1000) return false;
  const itemIds = new Set<string>();
  for (const destination of value.destinations) {
    if (!object(destination) || !identifier(destination.itemId) || !text(destination.channel)
        || !text(destination.destination) || itemIds.has(destination.itemId)) return false;
    itemIds.add(destination.itemId);
  }
  const attachmentIds = new Set<string>();
  for (const attachment of value.attachments) {
    if (!object(attachment) || !identifier(attachment.itemId) || !itemIds.has(attachment.itemId)
        || !text(attachment.path) || !digest(attachment.sha256)) return false;
    const key = `${attachment.itemId}\0${attachment.path}`;
    if (attachmentIds.has(key)) return false;
    attachmentIds.add(key);
  }
  return true;
}

function isRecord(value: unknown): value is ApprovalRecord {
  return isBinding(value) && object(value) && value.schemaVersion === 1 && identifier(value.id)
    && text(value.actor) && timestamp(value.createdAt) && timestamp(value.expiresAt)
    && ["approved", "revoked", "consumed"].includes(value.state as string);
}

/** Fixed-field serialization is independent of input object key insertion order. */
function bindingFields(binding: ApprovalBinding): string {
  return JSON.stringify([
    binding.batchId, binding.revision, binding.payloadSha256,
    binding.destinations.map(item => [item.itemId, item.channel, item.destination]),
    binding.attachments.map(item => [item.itemId, item.path, item.sha256]), binding.actionCount,
  ]);
}

/**
 * Diagnose a local record, never authenticate it. There is intentionally no true
 * return type and no optional verifier callback that workers could substitute.
 * Queue integrity/expiry must also be checked by the caller before this contract.
 */
export function inspectUntrustedApproval(record: unknown, expected: unknown, now = new Date()): ApprovalDenial {
  if (!isRecord(record) || !Number.isFinite(now.getTime())) return { ok: false, reason: "malformed_approval" };
  if (!isBinding(expected)) return { ok: false, reason: "malformed_binding" };
  if (record.state === "revoked") return { ok: false, reason: "revoked" };
  if (record.state === "consumed") return { ok: false, reason: "consumed" };
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (expiresAt <= createdAt || expiresAt - createdAt > MAX_APPROVAL_TTL_MS)
    return { ok: false, reason: "approval_ttl_exceeded" };
  if (expiresAt <= now.getTime()) return { ok: false, reason: "expired" };
  if (createdAt > now.getTime()) return { ok: false, reason: "not_yet_valid" };
  if (bindingFields(record) !== bindingFields(expected)) return { ok: false, reason: "binding_mismatch" };
  return { ok: false, reason: "operator_boundary_unavailable" };
}

export class OperatorApprovalUnavailableError extends Error {
  readonly code = "operator_boundary_unavailable";
  constructor() {
    super("Operator-only identity separation is unavailable; no approval was created.");
    this.name = "OperatorApprovalUnavailableError";
  }
}

/**
 * Stage (c) deliberately cannot mint approval. CLI/MCP callers must privately
 * audit the denial; do not echo supplied contact, draft, or actor data in errors.
 */
export function requestOperatorApproval(_binding: unknown, _claimedActor?: unknown): never {
  throw new OperatorApprovalUnavailableError();
}

/** Revocation can remove permission, never confer it; this does not persist. */
export function markApprovalRevoked(record: unknown): ApprovalRecord {
  if (!isRecord(record)) throw new Error("Malformed approval record.");
  return {
    schemaVersion: 1, id: record.id, batchId: record.batchId, revision: record.revision,
    payloadSha256: record.payloadSha256,
    destinations: record.destinations.map(item => ({ itemId: item.itemId, channel: item.channel, destination: item.destination })),
    attachments: record.attachments.map(item => ({ itemId: item.itemId, path: item.path, sha256: item.sha256 })),
    actionCount: record.actionCount, actor: record.actor, createdAt: record.createdAt,
    expiresAt: record.expiresAt, state: "revoked",
  };
}
