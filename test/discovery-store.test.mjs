// Durable checkpoints: synthetic private DB only, no transport or personal input.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = mkdtempSync(join(tmpdir(), "jobbot-run-store-"));
process.env.JOBBOT_PRIVATE_DIR = join(fixture, ".private");
process.env.STATE_DIR = join(fixture, ".private", "state");
const DB = await import("../src/db.ts");
after(() => { DB.db.close(); rmSync(fixture, { recursive: true, force: true }); });

test("private checkpoints round-trip independently and advance revision", () => {
  const run = { id: "synthetic-run", status: "running", companies: [{ company: { name: "Synthetic", domain: "example.invalid" }, jobs: [] }] };
  assert.equal(DB.loadDiscoveryRun("missing"), undefined);
  DB.saveDiscoveryRun(run);
  assert.deepEqual(DB.loadDiscoveryRun(run.id), run);
  const loaded = DB.loadDiscoveryRun(run.id);
  loaded.status = "cancelled";
  assert.equal(DB.loadDiscoveryRun(run.id).status, "running", "caller mutation must not alter persisted data");
  DB.saveDiscoveryRun(loaded);
  assert.equal(DB.db.prepare("SELECT revision FROM discovery_runs WHERE id=?").get(run.id).revision, 2);
  const event = DB.getEvents(1)[0];
  assert.equal(event.ref, run.id);
  assert.equal(event.summary, "discovery checkpoint saved");
  assert.doesNotMatch(event.summary, /Synthetic|example/);
});

test("checkpoint and audit journal roll back together on journal failure", () => {
  const before = DB.loadDiscoveryRun("synthetic-run");
  DB.db.exec("CREATE TRIGGER fail_discovery_journal BEFORE INSERT ON events WHEN NEW.kind='discovery_checkpoint' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  try {
    assert.throws(() => DB.saveDiscoveryRun({ ...before, status: "completed" }), /synthetic failure/);
    assert.deepEqual(DB.loadDiscoveryRun(before.id), before);
    assert.throws(() => DB.saveDiscoveryRun({ id: "new-run", status: "running" }), /synthetic failure/);
    assert.equal(DB.loadDiscoveryRun("new-run"), undefined);
  } finally { DB.db.exec("DROP TRIGGER fail_discovery_journal"); }
});

test("invalid IDs and unserializable payloads leave no checkpoint", () => {
  for (const id of ["../escape", "", "bad name", "x".repeat(81)]) {
    assert.throws(() => DB.loadDiscoveryRun(id), /invalid/);
    assert.throws(() => DB.saveDiscoveryRun({ id }), /invalid/);
  }
  const cyclic = { id: "cycle" }; cyclic.self = cyclic;
  assert.throws(() => DB.saveDiscoveryRun(cyclic), /circular/);
  assert.equal(DB.loadDiscoveryRun("cycle"), undefined);
});

test("offline discovery resumes through private SQLite store and returns counts-only receipt", async () => {
  const { discoverCompanies } = await import("../src/discovery.ts");
  const { privateReadLedger } = await import("../src/discovery-ledger.ts");
  const { privateDiscoveryStore, discoveryReceipt } = await import("../src/discovery-store.ts");
  const now = 1800000000000;
  let tick = now;
  const adapter = {
    fixtureOnly: true,
    url: (phase) => `https://careers.example/${phase}`,
    read: async () => ({ status: 200, body: {} }),
    companies: () => ({ items: [] }),
    resolved: (_body, company) => company,
    jobs: () => ({ items: [{ url: "https://careers.example/jobs/synthetic", title: "Synthetic role" }] }),
  };
  const deps = { adapter, store: privateDiscoveryStore, ledger: privateReadLedger(), now: () => tick, sleep: async (ms) => { tick += ms; },
    policies: [{ host: "careers.example", allowed: true, operations: ["discover", "resolve", "jobs"], policyRef: "https://careers.example/terms", checkedAt: now - 1, expiresAt: now + 86400000 }] };
  const result = await discoverCompanies({ id: "durable-loop", execute: true, companies: [{ name: "Synthetic", domain: "example.invalid" }] }, deps);
  assert.equal(result.run.status, "completed");
  assert.deepEqual(discoveryReceipt(result.run), { id: "durable-loop", status: "completed", companies: 1, jobs: 1, requests: 2 });
  deps.adapter.read = async () => { throw new Error("completed resume must not fetch"); };
  const resumed = await discoverCompanies({ id: "durable-loop", execute: true, resume: true }, deps);
  assert.deepEqual(resumed.run, result.run);
});
