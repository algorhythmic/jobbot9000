/** Odin Option A: verification only. Signing keys and operator authentication stay in Odin. */
import { createPublicKey, verify } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { canonicalize } from "./review-queue.js";
import type { OdinApprovalPayload, OdinExpectedBinding } from "./execution-types.js";

export interface OdinVerificationConfig { keyId: string; publicKeyPem: string }
export class OdinApprovalError extends Error {
  readonly code = "odin_approval_denied";
  constructor() { super("Odin approval verification refused."); this.name = "OdinApprovalError"; }
}
const deny = (): never => { throw new OdinApprovalError(); };
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === keys.sort().join("\0");
}
/** Canonical UTF-8 message signed by Odin, including issuer and key selector. Never signs. */
export function signingBytes(envelope: { issuer: string; key_id: string; payload: unknown }): Buffer {
  return Buffer.from(canonicalize({ issuer: envelope.issuer, key_id: envelope.key_id, payload: envelope.payload }), "utf8");
}

export function verifyOdinApproval(artifact: unknown, expected: OdinExpectedBinding, config: OdinVerificationConfig, now: number): Readonly<OdinApprovalPayload> {
  try {
    // Canonicalization rejects accessors, prototypes, cycles and unexpected data types before reading fields.
    canonicalize(artifact); canonicalize(expected); canonicalize(config);
    if (!exact(artifact, ["issuer", "key_id", "payload", "signature"]) || artifact.issuer !== "odin"
      || !identifier(artifact.key_id) || !identifier(config.keyId) || artifact.key_id !== config.keyId
      || typeof artifact.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(artifact.signature)) return deny();
    const p = artifact.payload;
    if (!exact(p, ["approval_id", "batch_digest", "principal", "channel", "destinations_digest", "item_count", "issued_at", "expires_at", "nonce"])
      || !identifier(p.approval_id) || !identifier(p.nonce) || !digest(p.batch_digest) || !digest(p.destinations_digest)
      || !text(p.principal) || !text(p.channel) || !Number.isSafeInteger(p.item_count) || (p.item_count as number) < 1
      || (p.item_count as number) > 100 || !Number.isSafeInteger(p.issued_at) || !Number.isSafeInteger(p.expires_at)
      || !Number.isSafeInteger(now) || (p.issued_at as number) > now || (p.expires_at as number) <= now
      || (p.issued_at as number) < 0 || (p.expires_at as number) <= (p.issued_at as number)
      || (p.expires_at as number) - (p.issued_at as number) > 600000) return deny();
    if (!digest(expected.batchDigest) || !digest(expected.destinationsDigest)
      || p.batch_digest !== expected.batchDigest || p.destinations_digest !== expected.destinationsDigest
      || p.channel !== expected.channel || p.item_count !== expected.itemCount) return deny();
    const key = createPublicKey(config.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return deny();
    const signature = Buffer.from(artifact.signature, "base64");
    if (signature.toString("base64") !== artifact.signature || !verify(null, signingBytes({ issuer: artifact.issuer, key_id: artifact.key_id, payload: p }), key, signature)) return deny();
    // The deciding principal is an Odin-authenticated assertion covered by the signature,
    // never an actor/role supplied by a worker. This module cannot create an approval.
    return Object.freeze(JSON.parse(canonicalize(p)) as OdinApprovalPayload);
  } catch { return deny(); }
}

/**
 * Load only a protected, externally provisioned trust anchor under .private.
 * Same-UID writable configuration would let workers replace Odin's public key and
 * mint approvals with their own key, so shared worker/operator directories refuse.
 * Every ancestor must also resist worker writes (rename/replacement attacks).
 * Deployment must provision this path outside the worker's writable capabilities.
 */
export function loadOdinVerificationConfig(path: string): Readonly<OdinVerificationConfig> {
  try {
    if (!isAbsolute(path) || !resolve(path).split(sep).includes(".private")) return deny();
    const target = resolve(path);
    for (let cursor = target; ; cursor = dirname(cursor)) {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (cursor === target ? !stat.isFile() : !stat.isDirectory())) return deny();
      let writable = false;
      try { accessSync(cursor, constants.W_OK); writable = true; } catch { /* Expected: outside worker write capability. */ }
      if (writable || (stat.mode & 0o022)) return deny();
      if (dirname(cursor) === cursor) break;
    }
    const config: unknown = JSON.parse(readFileSync(target, "utf8"));
    if (!exact(config, ["keyId", "publicKeyPem"]) || !identifier(config.keyId) || typeof config.publicKeyPem !== "string") return deny();
    if (createPublicKey(config.publicKeyPem).asymmetricKeyType !== "ed25519") return deny();
    return Object.freeze({ keyId: config.keyId, publicKeyPem: config.publicKeyPem });
  } catch { return deny(); }
}
