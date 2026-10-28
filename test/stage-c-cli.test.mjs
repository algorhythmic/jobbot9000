// Synthetic private command acceptance; no real resume/profile or network.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareDrafts } from "../src/preparation.ts";
import { createReviewBatch } from "../src/review-queue.ts";
import { runJobbot, approvalBinding } from "../src/cli.ts";
import { importResume } from "../src/resume-import.ts";
import { inspectUntrustedApproval } from "../src/approval.ts";
const now = 1800000000000;
const base = resolve(".private/test-stage-c"); mkdirSync(base, { recursive: true, mode: 0o700 });
const fixture = mkdtempSync(join(base, "cli-"));
const profile = JSON.parse(readFileSync(new URL("./fixtures/synthetic-profile.json", import.meta.url), "utf8"));
const originalFetch = globalThis.fetch; let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error("network prohibited"); };
after(() => { globalThis.fetch = originalFetch; rmSync(fixture, { recursive: true, force: true }); assert.equal(networkCalls, 0); });
function context() {
  const parent = mkdtempSync(join(fixture, "case-")), privateDir = join(parent, ".private");
  const output = [], errors = [];
  return { privateDir, now, isSuppressed: () => false, out: (s) => output.push(s), error: (s) => errors.push(s), output, errors, parent };
}
function batch(c) {
  const now = c.now;
  const items = prepareDrafts([{ profile, evidence: { approved: true, companyId: "synthetic-company", roleId: "synthetic-role", companyName: "Synthetic Co", roleTitle: "Synthetic Role", sourceUrl: "https://careers.example.test/job", description: "Synthetic role", fetchedAt: now - 1000, expiresAt: now + 500000, terms: { allowed: true, reference: "https://careers.example.test/terms", checkedAt: now - 1000, expiresAt: now + 500000 }, roleFit: { band: "exact", desireAlignment: "strong", rationale: "Synthetic rationale" } }, channel: "manual_application", destination: "https://careers.example.test/job", claimIds: ["fixture-claim"], requestedLevel: "mid", requiredFields: ["name", "cover_letter", "salary"] }], c);
  return createReviewBatch(c.privateDir, { batchId: "synthetic-r1", revision: 1, createdAt: now, expiresAt: now + 100000, items, attachments: [{ id: "resume", name: "Synthetic attachment", bytes: Buffer.from("SYNTHETIC ATTACHMENT FULL END") }] }, { ...c, persist: true });
}
test("review command displays complete verified preview with fields and full attachment bytes", () => {
  const c = context(), result = batch(c);
  assert.equal(runJobbot(["review", "synthetic-r1"], c), 0);
  assert.deepEqual(c.output, [result.preview]); assert.match(c.output[0], /manualCompletion/); assert.match(c.output[0], /salary/);
  assert.match(c.output[0], new RegExp(Buffer.from("SYNTHETIC ATTACHMENT FULL END").toString("base64")));
});
test("approve-send binds exact digest but always refuses same-identity operator claims", () => {
  const c = context(), result = batch(c);
  assert.equal(runJobbot(["approve-send", "synthetic-r1", "--sha256", result.manifest.payloadSha256], c), 1);
  assert.match(c.errors.join(""), /operator_boundary_unavailable/);
  assert.equal(existsSync(join(c.privateDir, "review", "synthetic-r1", "approval.json")), false);
  assert.match(readFileSync(join(c.privateDir, "audit", "events.jsonl"), "utf8"), /approval_denied/);
  assert.equal(inspectUntrustedApproval({}, approvalBinding(result), new Date(now)).ok, false);
});
test("wrong digest, changed payload and suppressed targets cannot be approved or reviewed", () => {
  const c = context(), result = batch(c);
  assert.equal(runJobbot(["approve-send", "synthetic-r1", "--sha256", "0".repeat(64)], c), 1);
  assert.equal(runJobbot(["review", "synthetic-r1"], { ...c, isSuppressed: () => true }), 1);
  const path = join(c.privateDir, "review", "synthetic-r1", "items", `${result.items[0].id}.json`);
  const altered = JSON.parse(readFileSync(path, "utf8")); altered.destination = "https://other.example.test/job"; writeFileSync(path, JSON.stringify(altered));
  assert.equal(runJobbot(["review", "synthetic-r1"], c), 1);
  assert.doesNotMatch(c.errors.join(""), /Synthetic Candidate|other\.example|verified level/);
});
test("revocation is a private negative record and never mints an approval", () => {
  const c = context(); batch(c);
  assert.equal(runJobbot(["revoke-approval", "synthetic-r1"], c), 0);
  assert.match(readFileSync(join(c.privateDir, "audit", "events.jsonl"), "utf8"), /revocation/);
  assert.equal(existsSync(join(c.privateDir, "review", "synthetic-r1", "approval.json")), false);
});
test("resume import defaults to zero reads/writes and explicit import stays under .private", () => {
  const c = context(); const source = join(c.parent, "synthetic-input.txt");
  assert.deepEqual(importResume(c.privateDir, source, "resume"), { dryRun: true, imported: false });
  assert.equal(existsSync(c.privateDir), false);
  writeFileSync(source, "Entirely synthetic resume fixture.");
  assert.equal(runJobbot(["import-resume", "--source", source, "--id", "synthetic", "--write"], c), 0);
  const target = join(c.privateDir, "profile", "synthetic.resume");
  assert.equal(readFileSync(target, "utf8"), "Entirely synthetic resume fixture.");
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.match(readFileSync(join(c.privateDir, "audit", "events.jsonl"), "utf8"), /resume_import/);
  assert.throws(() => importResume(c.privateDir, source, "synthetic", true));
});
test("resume output symlinks and nonprivate roots fail before copying", () => {
  const c = context(), source = join(c.parent, "input.txt"); writeFileSync(source, "Synthetic input");
  assert.throws(() => importResume(join(c.parent, "public"), source, "id", true));
  mkdirSync(c.privateDir); const elsewhere = join(c.parent, "other"); mkdirSync(elsewhere); symlinkSync(elsewhere, join(c.privateDir, "profile"));
  assert.throws(() => importResume(c.privateDir, source, "id", true));
  assert.equal(existsSync(join(elsewhere, "id.resume")), false);
});

test("MCP exposes full audited review only, with no approval/send tool", async () => {
  const c = context(); c.now = Date.now();
  // Build a separately fresh synthetic revision for the MCP's wall clock.
  const items = prepareDrafts([{ profile, evidence: { approved: true, companyId: "synthetic-company", roleId: "mcp-role", companyName: "Synthetic Co", roleTitle: "Synthetic Role", sourceUrl: "https://careers.example.test/job", description: "Synthetic", fetchedAt: c.now - 1000, expiresAt: c.now + 500000, terms: { allowed: true, reference: "https://careers.example.test/terms", checkedAt: c.now - 1000, expiresAt: c.now + 500000 }, roleFit: { band: "exact", desireAlignment: "strong", rationale: "Synthetic match" } }, channel: "manual_application", destination: "https://careers.example.test/job", claimIds: ["fixture-claim"], requestedLevel: "mid", requiredFields: ["name"] }], c);
  const result = createReviewBatch(c.privateDir, { batchId: "mcp-r1", revision: 1, createdAt: c.now, expiresAt: c.now + 100000, items }, { ...c, persist: true });
  process.env.JOBBOT_PRIVATE_DIR = c.privateDir; process.env.STATE_DIR = join(c.privateDir, "state");
  const DB = await import("../src/db.ts");
  try {
    const { registerTools } = await import("../src/tools.ts");
    const handlers = new Map();
    registerTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) });
    const reply = JSON.parse((await handlers.get("review_batch")({ batch_id: "mcp-r1" })).content[0].text);
    assert.equal(reply.ok, true); assert.equal(reply.preview, result.preview);
    assert.equal(handlers.has("approve_send"), false); assert.equal(handlers.has("send"), false); assert.equal(handlers.has("execute"), false);
  } finally { DB.db.close(); }
});

// The distributed entry point must be exercised after `npm run build`: unit
// invocation alone cannot detect stale or silently terminating CLI bundles.
test("packaged CLI emits full fresh preview and rejects approval with an explicit error", (t) => {
  if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED) return t.skip("nested Node spawn is denied by the workspace sandbox; run packaged CLI acceptance outside sandbox");
  if (!existsSync(resolve("dist/cli.js"))) return t.skip("packaged CLI requires npm run build first");
  const c = context(); c.now = Date.now();
  const result = batch(c);
  const env = { ...process.env, JOBBOT_PRIVATE_DIR: c.privateDir, STATE_DIR: join(c.privateDir, "state") };
  const invoke = (args) => spawnSync(process.execPath, ["bin/jobbot.mjs", ...args], { encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
  const review = invoke(["review", "synthetic-r1"]);
  assert.equal(review.error, undefined); assert.equal(review.status, 0);
  assert.equal(review.stdout, result.preview + "\n"); assert.equal(review.stderr, "");
  const approval = invoke(["approve-send", "synthetic-r1", "--sha256", result.manifest.payloadSha256]);
  assert.equal(approval.error, undefined); assert.equal(approval.status, 1); assert.equal(approval.stdout, "");
  assert.match(approval.stderr, /operator_boundary_unavailable/);
  assert.equal(existsSync(join(c.privateDir, "review", "synthetic-r1", "approval.json")), false);
});
