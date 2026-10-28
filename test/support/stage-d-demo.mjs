// TEST-ONLY Odin simulator: fresh throwaway private key stays in memory. Never use
// this signer or its worker-owned public-key file as a production trust anchor.
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { prepareDrafts } from "../../src/preparation.ts";
import { parsePeoplePublication } from "../../src/people-sources.ts";
import { createReviewBatch } from "../../src/review-queue.ts";
import { signingBytes } from "../../src/odin-approval.ts";
import { executeApprovedBatch, executionBinding, reconcileApprovedExecution } from "../../src/executor.ts";
import { createMockTransport } from "../../src/mock-transport.ts";
const send = process.argv.slice(2).includes("--send");
const unknown = process.argv.slice(2).includes("--unknown");
if (process.argv.slice(2).some((arg) => !["--send", "--unknown"].includes(arg))) throw new Error("Only --send and --unknown are supported by this synthetic demo.");
const base = resolve(".private/build/stage-d-demo"); mkdirSync(base, { recursive: true, mode: 0o700 });
const privateDir = join(mkdtempSync(join(base, "run-")), ".private");
const now = Date.now();
const profile = JSON.parse(readFileSync(new URL("../fixtures/synthetic-profile.json", import.meta.url), "utf8"));
const contact = parsePeoplePublication({ companyId: "synthetic-company", sourceUrl: "https://careers.example.test/team", sourceKind: "official_team", public: true, professional: true,
  text: "Synthetic Recruiter is a recruiter. Synthetic Recruiter professional recruiting email: published@example.test",
  contacts: [{ name: "Synthetic Recruiter", role: "recruiter", roleEvidence: "Synthetic Recruiter is a recruiter.", channels: [{ kind: "email", value: "published@example.test", evidence: "Synthetic Recruiter professional recruiting email: published@example.test" }] }],
}, { now })[0];
const checks = { now, isSuppressed: () => false };
const items = prepareDrafts([{ profile, evidence: { approved: true, companyId: "synthetic-company", roleId: "synthetic-role", companyName: "Synthetic Company", roleTitle: "Synthetic Engineer", sourceUrl: "https://careers.example.test/jobs/fixture", description: "Synthetic public professional job fixture.", fetchedAt: now, expiresAt: now + 1800000,
  terms: { allowed: true, reference: "https://careers.example.test/terms", checkedAt: now, expiresAt: now + 1800000 }, roleFit: { band: "exact", desireAlignment: "strong", rationale: "Synthetic verified match." } },
  channel: "email", contact, contactApproved: true, destination: "published@example.test", claimIds: ["fixture-claim"], requestedLevel: "mid", requiredFields: [] }], checks);
const batch = createReviewBatch(privateDir, { batchId: "synthetic-r1", revision: 1, createdAt: now, expiresAt: now + 600000, items }, { ...checks, persist: true });
const expected = executionBinding(batch);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const authority = { keyId: "synthetic-odin-test-key", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
const envelope = { issuer: "odin", key_id: authority.keyId, payload: { approval_id: randomUUID(), batch_digest: expected.batchDigest,
  principal: "synthetic-operator", channel: expected.channel, destinations_digest: expected.destinationsDigest, item_count: expected.itemCount,
  issued_at: now, expires_at: now + 120000, nonce: randomUUID() } };
const artifact = { ...envelope, signature: sign(null, signingBytes(envelope), privateKey).toString("base64") };
// Only PUBLIC verification configuration is persisted, under this synthetic root.
mkdirSync(join(privateDir, "odin"), { recursive: true, mode: 0o700 });
writeFileSync(join(privateDir, "odin", "verify-key.json"), JSON.stringify(authority), { mode: 0o600 });
writeFileSync(join(privateDir, "odin", "test-approval.json"), JSON.stringify(artifact), { mode: 0o600 });
process.env.JOBBOT_PRIVATE_DIR = privateDir; process.env.STATE_DIR = join(privateDir, "state");
const DB = await import("../../src/db.ts");
const { privateExecutionStore } = await import("../../src/execution-store.ts");
const adapter = createMockTransport({ behavior: unknown ? "accept_then_timeout" : "success" });
const deps = { store: privateExecutionStore, adapter, authority, isSuppressed: DB.isPrivatePersonSuppressed, now: Date.now };
try {
  const result = await executeApprovedBatch({ privateDir, batchId: "synthetic-r1", send, approval: artifact }, deps);
  let reconciled;
  if (result.status === "unknown") reconciled = await reconcileApprovedExecution(result.executionId, deps);
  let replayRefused = false;
  if (send) { try { await executeApprovedBatch({ privateDir, batchId: "synthetic-r1", send: true, approval: artifact }, deps); } catch { replayRefused = true; } }
  const receipt = { synthetic: true, status: result.status, reconciledStatus: reconciled?.status ?? null, executionId: result.executionId ?? null,
    receiptId: reconciled?.receiptId ?? result.receiptId ?? null, mockCalls: adapter.sendCalls, replayRefused, privateArtifacts: privateDir };
  writeFileSync(join(privateDir, "demo-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(receipt));
  if (send && (adapter.sendCalls !== 1 || !replayRefused || !["succeeded", "unknown"].includes(result.status))) process.exitCode = 1;
  if (!send && adapter.sendCalls !== 0) process.exitCode = 1;
} finally { DB.db.close(); }
