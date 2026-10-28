// Synthetic offline queue acceptance. All generated files stay in workspace .private.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, symlinkSync, linkSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalize, canonicalSha256, createReviewBatch, verifyReviewBatch, reviewBatch } from "../src/review-queue.ts";
import { prepareDrafts } from "../src/preparation.ts";
const now = 1800000000000;
const checks = { now, isSuppressed: () => false };
const base = resolve(".private/test-stage-c"); mkdirSync(base, { recursive: true, mode: 0o700 });
const temp = mkdtempSync(join(base, "queue-"));
const profile = JSON.parse(readFileSync(new URL("./fixtures/synthetic-profile.json", import.meta.url), "utf8"));
let calls = 0; const savedFetch = globalThis.fetch;
globalThis.fetch = () => { calls++; throw new Error("network prohibited"); };
after(() => { globalThis.fetch = savedFetch; rmSync(temp, { recursive: true, force: true }); assert.equal(calls, 0); });
function root() { const parent = mkdtempSync(join(temp, "case-")); return join(parent, ".private"); }
function draft() {
  return prepareDrafts([{
    profile: structuredClone(profile),
    evidence: { approved: true, companyId: "synthetic-company", roleId: "synthetic-role", companyName: "Synthetic Company", roleTitle: "Synthetic Engineer", sourceUrl: "https://careers.example.test/jobs/synthetic", description: "Public synthetic job description.", fetchedAt: now - 1000, expiresAt: now + 100000,
      terms: { allowed: true, reference: "https://careers.example.test/terms", checkedAt: now - 1000, expiresAt: now + 100000 }, roleFit: { band: "exact", desireAlignment: "strong", rationale: "Synthetic match." } },
    channel: "manual_application", destination: "https://careers.example.test/jobs/synthetic", claimIds: ["fixture-claim"], requestedLevel: "mid", requiredFields: ["name", "cover_letter", "unsupported_field"],
  }], checks)[0];
}
function input(extra = {}) { return { batchId: "synthetic-r1", revision: 1, createdAt: now, expiresAt: now + 50000, items: [draft()], ...extra }; }
function persist(dir, extra = {}) { return createReviewBatch(dir, input(extra), { ...checks, persist: true }); }
function itemPath(dir, batch = "synthetic-r1") { return join(dir, "review", batch, "items", `${draft().id}.json`); }

test("canonicalization stable across key order, Unicode and numeric spellings", () => {
  assert.equal(canonicalize({ b: 2, a: { z: "λ", a: 0 } }), canonicalize({ a: { a: -0, z: "λ" }, b: 2 }));
  assert.equal(canonicalSha256({ b: 1, a: 2 }), canonicalSha256({ a: 2, b: 1 }));
  assert.notEqual(canonicalSha256({ a: "1" }), canonicalSha256({ a: 1 }));
});
for (const [label, value] of [["undefined", undefined], ["NaN", NaN], ["infinity", Infinity], ["sparse array", Array(2)], ["date", new Date(0)], ["prototype", JSON.parse('{"__proto__":{}}')], ["function", () => {}]]) test(`canonicalization rejects ${label}`, () => assert.throws(() => canonicalize(value)));
test("canonicalization rejects cycles and accessors without running them", () => {
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => canonicalize(cyclic));
  let reads = 0; const accessor = { get sensitive() { reads++; return "synthetic"; } };
  assert.throws(() => canonicalize(accessor)); assert.equal(reads, 0);
});
test("dry-run is default and causes zero private writes", () => {
  const dir = root(); const result = createReviewBatch(dir, input(), checks);
  assert.equal(result.dryRun, true); assert.equal(result.manifest.dryRun, true);
  assert.equal(readdirSync(resolve(dir, "..")).length, 0);
});
test("private persisted layout is complete and restricted; review audit is redacted", () => {
  const dir = root(), result = persist(dir, { attachments: [{ id: "attachment-1", name: "synthetic.txt", bytes: Buffer.from("Synthetic attachment") }] });
  const verified = reviewBatch(dir, "synthetic-r1", checks);
  assert.equal(verified.manifest.payloadSha256, result.manifest.payloadSha256);
  assert.equal(statSync(join(dir, "review", "synthetic-r1", "manifest.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "review", "synthetic-r1")).mode & 0o777, 0o700);
  assert.equal(verified.items.length, 1); assert.equal(verified.attachments.length, 1);
  assert.match(verified.preview, /unsupported_field/);
  assert.match(verified.preview, new RegExp(Buffer.from("Synthetic attachment").toString("base64")));
  const audit = readFileSync(join(dir, "audit", "events.jsonl"), "utf8");
  assert.equal(audit.trim().split("\n").length, 2); assert.doesNotMatch(audit, /Synthetic Candidate|careers\.example|body|destination/);
});
for (const field of ["body", "destination", "subject"]) test(`tampered draft ${field} fails closed`, () => {
  const dir = root(); persist(dir); const path = itemPath(dir); const changed = JSON.parse(readFileSync(path, "utf8")); changed[field] += " tampered"; writeFileSync(path, JSON.stringify(changed));
  assert.throws(() => verifyReviewBatch(dir, "synthetic-r1", checks), /integrity/);
});
test("tampered manifest, attachment and preview each fail closed", () => {
  for (const artifact of ["manifest.json", "attachments/attachment-1", "review.md"]) {
    const dir = root(); persist(dir, { attachments: [{ id: "attachment-1", name: "synthetic.bin", bytes: Buffer.from([0, 1, 255]) }] });
    const path = join(dir, "review", "synthetic-r1", artifact);
    if (artifact === "manifest.json") { const m = JSON.parse(readFileSync(path)); m.expiresAt++; writeFileSync(path, JSON.stringify(m)); } else writeFileSync(path, "tampered");
    assert.throws(() => verifyReviewBatch(dir, "synthetic-r1", checks), /integrity/);
  }
});
test("expiry, suppression, missing callbacks and duplicate contacts deny queue ingress and review", () => {
  const dir = root(); persist(dir);
  assert.throws(() => verifyReviewBatch(dir, "synthetic-r1", { ...checks, now: now + 50000 }));
  assert.throws(() => verifyReviewBatch(dir, "synthetic-r1", { ...checks, isSuppressed: () => true }));
  assert.throws(() => createReviewBatch(root(), input(), { now, persist: true }));
  assert.throws(() => persist(root(), { items: [draft(), draft()] }));
  assert.throws(() => createReviewBatch(root(), input(), { ...checks, isSuppressed: () => true, persist: true }));
});
test("immutable revisions cannot overwrite and edits require new batch ID and digest", () => {
  const dir = root(); const first = persist(dir);
  assert.throws(() => persist(dir), /already exists/);
  const second = persist(dir, { batchId: "synthetic-r2", revision: 2, previousBatchId: "synthetic-r1", attachments: [{ id: "new-attachment", name: "synthetic.txt", bytes: Buffer.from("new") }] });
  assert.notEqual(first.manifest.payloadSha256, second.manifest.payloadSha256);
  assert.equal(second.manifest.previous.payloadSha256, first.manifest.payloadSha256);
  assert.equal(verifyReviewBatch(dir, "synthetic-r1", checks).manifest.payloadSha256, first.manifest.payloadSha256);
  assert.throws(() => persist(dir, { batchId: "synthetic-r3", revision: 3 }));
  assert.throws(() => persist(dir, { batchId: "synthetic-r4", revision: 4, previousBatchId: "synthetic-r1" }));
});
test("complete preview escapes source HTML and never truncates large drafts or attachment bytes", () => {
  const dir = root(), item = draft(); item.recipe.profile.claims[0].text = "<script>synthetic</script>" + "x".repeat(60000) + "END-SYNTHETIC";
  const rebuilt = prepareDrafts([item.recipe], checks)[0];
  const result = persist(dir, { items: [rebuilt], attachments: [{ id: "escaped", name: "</pre><script>synthetic</script>", bytes: Buffer.from("END-ATTACHMENT") }] });
  assert.doesNotMatch(result.preview, /<script>/); assert.match(result.preview, /&lt;script&gt;/); assert.match(result.preview, /END-SYNTHETIC/);
  assert.equal(result.preview.includes("x".repeat(60000)), true);
  assert.equal(verifyReviewBatch(dir, "synthetic-r1", checks).preview, result.preview);
});
test("path traversal, external roots, symlinks and hard-linked private files fail closed", () => {
  assert.throws(() => persist(resolve(temp, "public")));
  assert.throws(() => persist(root(), { batchId: "../escape-r1" }));
  const dir = root(); persist(dir);
  const path = itemPath(dir), copy = join(dir, "linked"); linkSync(path, copy);
  assert.throws(() => verifyReviewBatch(dir, "synthetic-r1", checks));
  const other = root(); mkdirSync(other, { mode: 0o700 }); symlinkSync(dir, join(other, "review"));
  assert.throws(() => persist(other));
});
test("transport-free queue leaves no temporary artifacts outside private root", () => {
  const dir = root(); persist(dir);
  assert.equal(readdirSync(join(dir, "review")).some(name => name.startsWith(".pending")), false);
  assert.equal(calls, 0);
});
test("array accessors and hidden instructions never execute during canonicalization", () => {
  let reads = 0; const array = [1]; Object.defineProperty(array, "0", { enumerable: true, get() { reads++; return "run command"; } });
  assert.throws(() => canonicalize(array)); assert.equal(reads, 0);
  const extra = [1]; extra.command = "run command"; assert.throws(() => canonicalize(extra));
});
test("failure writing private audit never publishes a reviewable manifest", () => {
  const dir = root(); mkdirSync(join(dir, "audit"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "audit", "events.jsonl"), { mode: 0o700 });
  assert.throws(() => persist(dir), /persistence failed/);
  assert.deepEqual(readdirSync(join(dir, "review")), []);
});
test("duplicate company/role is denied even if recipe and destination differ", () => {
  const one = draft(), recipe = structuredClone(one.recipe);
  recipe.evidence.sourceUrl = recipe.destination = "https://careers.example.test/jobs/alternate";
  const two = prepareDrafts([recipe], checks)[0];
  assert.notEqual(one.id, two.id); assert.notEqual(one.destination, two.destination);
  assert.throws(() => persist(root(), { items: [one, two] }), /duplicate/);
});
