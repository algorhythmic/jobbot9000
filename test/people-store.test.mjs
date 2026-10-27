// Synthetic-only private persistence; no transport or real personal input.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = mkdtempSync(join(tmpdir(), "jobbot-people-store-"));
process.env.JOBBOT_PRIVATE_DIR = join(fixture, ".private");
process.env.STATE_DIR = join(fixture, ".private", "state");
const DB = await import("../src/db.ts");
const { privatePeopleStore: store } = await import("../src/people-store.ts");
const { parsePeoplePublication } = await import("../src/people-sources.ts");
const epoch = 1800000000000;
const finding = (name = "Synthetic Recruiter", ttlMs, email = `synthetic-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}@example.test`) => parsePeoplePublication({
  companyId: "synthetic-company", sourceUrl: "https://careers.example.test/team", sourceKind: "official_team",
  public: true, professional: true,
  text: `${name} is a recruiter. ${name} professional recruiting email: ${email}`,
  contacts: [{ name, role: "recruiter", roleEvidence: `${name} is a recruiter.`, channels: [{ kind: "email", value: email, evidence: `${name} professional recruiting email: ${email}` }] }],
}, { now: epoch, ...(ttlMs === undefined ? {} : { ttlMs }) })[0];
after(() => { DB.db.close(); rmSync(fixture, { recursive: true, force: true }); });

const verify = (condition, message) => assert.ok(condition, message);
test("private findings round trip and review copies cannot mutate durable payloads", () => {
  const p = finding();
  assert.equal(store.collect(p), true);
  assert.equal(store.collect(p), true);
  const review = store.review(epoch);
  assert.deepEqual(review, [{ person: p, stale: false, needsReview: true }]);
  review[0].person.name = "Mutation";
  assert.equal(store.review(epoch)[0].person.name, p.name);
  assert.equal(DB.db.prepare("SELECT count(*) c FROM people_findings").get().c, 1);
  verify(readdirSync(fixture).every((name) => name === ".private"));
  for (const path of [process.env.JOBBOT_PRIVATE_DIR, process.env.STATE_DIR]) assert.equal(statSync(path).mode & 0o777, 0o700);
  for (const suffix of ["", "-wal", "-shm"]) assert.equal(statSync(join(process.env.STATE_DIR, `jobbot.db${suffix}`)).mode & 0o777, 0o600);
});

test("direct persistence ingress rejects malformed or policy-denied findings without retaining PII", () => {
  const p = finding();
  for (const bad of [null, {}, { ...p, id: "../escape" }, { ...p, arbitrary: "secret" },
    { ...p, provenance: { ...p.provenance, sourceKind: "bought_list" } },
    { ...p, provenance: { ...p.provenance, sourceUrl: "https://www.linkedin.com/in/synthetic" } },
    { ...p, provenance: { ...p.provenance, expiresAt: NaN } },
    { ...p, id: "forged-identity" },
    { ...p, channels: [{ kind: "email", value: "guess@example.test", evidence: "guessed" }] },
  ]) assert.throws(() => store.collect(bad));
  assert.equal(DB.db.prepare("SELECT count(*) c FROM people_findings").get().c, 1);
});

test("suppression and deletion immediately purge queue and payloads and block recollection", () => {
  const suppressed = finding("Synthetic Suppressed");
  const deleted = finding("Synthetic Deleted");
  store.collect(suppressed); store.collect(deleted);
  store.suppress(suppressed.id); store.delete(deleted.id);
  assert.equal(store.collect(suppressed), false);
  assert.equal(store.collect({ ...suppressed, provenance: { ...suppressed.provenance, sourceUrl: "https://careers.example.test/other-team" } }), false, "changing publication source cannot bypass suppression");
  assert.equal(store.collect(deleted), false);
  assert.equal(store.collect(finding("Synthetic Renamed", undefined, suppressed.channels[0].value)), false, "changing name cannot bypass channel suppression");
  assert.equal(store.collect(finding("Synthetic Deleted Renamed", undefined, deleted.channels[0].value)), false, "changing name cannot bypass channel deletion");
  assert.equal(store.review(epoch).length, 1);
  const rows = JSON.stringify(DB.db.prepare("SELECT * FROM people_findings").all());
  assert.doesNotMatch(rows, /Synthetic Suppressed|Synthetic Deleted/);
  const tombstones = DB.db.prepare("SELECT * FROM people_tombstones").all();
  assert.equal(tombstones.length, 2);
  for (const row of tombstones) { assert.match(row.id_hash, /^[a-f0-9]{64}$/); assert.deepEqual(Object.keys(row).sort(), ["id_hash", "reason"]); }
  const channelTombstones = DB.db.prepare("SELECT * FROM people_blocked_channels").all();
  assert.equal(channelTombstones.length, 2);
  for (const row of channelTombstones) { assert.match(row.channel_hash, /^[a-f0-9]{64}$/); assert.deepEqual(Object.keys(row).sort(), ["channel_hash", "reason"]); }
  const events = JSON.stringify(DB.db.prepare("SELECT * FROM events WHERE kind LIKE 'people_%'").all());
  assert.doesNotMatch(events, /Synthetic|example\.test|https:|recruiter/);
  assert.equal(DB.db.pragma("secure_delete")[0].secure_delete, 1);
});

test("default 30-day TTL and configurable TTL purge PII at exact expiry before review", () => {
  const p = finding("Synthetic Expired", 1000);
  const defaultTtl = finding("Synthetic Default TTL");
  assert.equal(defaultTtl.provenance.expiresAt - epoch, 30 * 24 * 60 * 60 * 1000);
  store.collect(p);
  assert.ok(store.review(epoch + 999).some((item) => item.person.id === p.id));
  assert.ok(!store.review(epoch + 1000).some((item) => item.person.id === p.id));
  assert.doesNotMatch(JSON.stringify(DB.db.prepare("SELECT * FROM people_findings").all()), /Synthetic Expired/);
  store.collect(p); assert.equal(store.purgeExpired(epoch + 1000), 1);
  assert.equal(store.purgeExpired(epoch + 1000), 0);
  for (const now of [NaN, Infinity, -1, epoch + 0.5]) { assert.throws(() => store.review(now)); assert.throws(() => store.purgeExpired(now)); }
});

test("collection, deletion and expiry journal failures roll back all associated changes", () => {
  const p = finding("Synthetic Rollback", 1000);
  const before = DB.db.prepare("SELECT count(*) c FROM people_findings").get().c;
  DB.db.exec("CREATE TRIGGER fail_people_journal BEFORE INSERT ON events WHEN NEW.kind LIKE 'people_%' BEGIN SELECT RAISE(ABORT,'synthetic people failure'); END");
  try {
    assert.throws(() => store.collect(p), /synthetic people failure/);
    assert.equal(DB.db.prepare("SELECT count(*) c FROM people_findings").get().c, before);
  } finally { DB.db.exec("DROP TRIGGER fail_people_journal"); }
  assert.equal(store.collect(p), true);
  DB.db.exec("CREATE TRIGGER fail_people_journal BEFORE INSERT ON events WHEN NEW.kind LIKE 'people_%' BEGIN SELECT RAISE(ABORT,'synthetic people failure'); END");
  try {
    assert.throws(() => store.delete(p.id), /synthetic people failure/);
    assert.throws(() => store.suppress(p.id), /synthetic people failure/);
    assert.throws(() => store.purgeExpired(epoch + 1000), /synthetic people failure/);
    assert.ok(store.review(epoch).some((item) => item.person.id === p.id));
  } finally { DB.db.exec("DROP TRIGGER fail_people_journal"); }
  assert.equal(store.collect(p), true, "tombstones must also roll back");
});


test("future-dated evidence is withheld from private review", () => {
  const future = finding("Synthetic Future");
  assert.equal(store.collect(future), true);
  assert.deepEqual(store.review(epoch - 1), []);
  assert.ok(store.review(epoch).some((item) => item.person.id === future.id));
});

test("suppression purges existing aliases that share a published channel", () => {
  const one = finding("Synthetic Alias One");
  const two = finding("Synthetic Alias Two", undefined, one.channels[0].value);
  store.collect(one); store.collect(two);
  store.suppress(one.id);
  const remaining = JSON.stringify(store.review(epoch));
  assert.doesNotMatch(remaining, /Synthetic Alias/);
  assert.equal(store.collect(two), false);
});

test("reopen preserves private review and minimal suppression tombstones", async () => {
  const { default: Database } = await import("../src/sqlite.ts");
  const reopened = new Database(join(process.env.STATE_DIR, "jobbot.db"));
  try {
    assert.equal(reopened.pragma("integrity_check")[0].integrity_check, "ok");
    assert.equal(reopened.prepare("SELECT count(*) c FROM people_tombstones").get().c, 4);
    assert.ok(reopened.prepare("SELECT count(*) c FROM people_findings").get().c > 0);
    const events = JSON.stringify(reopened.prepare("SELECT * FROM events WHERE kind LIKE 'people_%'").all());
    assert.doesNotMatch(events, /Synthetic|example\.test/);
  } finally { reopened.close(); }
});

test("collector, durable read ledger and private review store integrate without a send capability", async () => {
  const { collectPeople } = await import("../src/people.ts");
  const { privateReadLedger } = await import("../src/discovery-ledger.ts");
  let tick = epoch;
  const name = "Synthetic Integration Recruiter";
  const email = "integration-published@example.test";
  const source = { companyId: "integration-company", url: "https://careers.example.test/team", kind: "official_team", public: true, professional: true };
  let calls = 0;
  const body = { text: `${name} is a recruiter. ${name} professional recruiting email: ${email}`, contacts: [{ name, role: "recruiter", roleEvidence: `${name} is a recruiter.`, channels: [{ kind: "email", value: email, evidence: `${name} professional recruiting email: ${email}` }] }] };
  const deps = { adapter: { fixtureOnly: true, read: async (request) => { calls++; assert.equal(request.method, "GET"); return { status: 200, body }; } },
    store, ledger: privateReadLedger(), now: () => tick, sleep: async (ms) => { tick += ms; },
    policies: [{ host: "careers.example.test", allowed: true, operations: ["discover"], policyRef: "https://careers.example.test/terms", checkedAt: epoch - 1, expiresAt: epoch + 86400000 }] };
  const options = { id: "integration-run", execute: true, sources: [source] };
  const result = await collectPeople(options, deps);
  assert.equal(result.counts.collected, 1); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic Integration|integration-published@|https:/);
  const queued = store.review(tick).filter((item) => item.person.companyId === source.companyId);
  assert.equal(queued.length, 1); assert.equal(queued[0].needsReview, true);
  store.delete(queued[0].person.id);
  assert.equal((await collectPeople(options, deps)).counts.suppressed, 1);
  assert.equal(store.review(tick).filter((item) => item.person.companyId === source.companyId).length, 0);
  assert.doesNotMatch(JSON.stringify(DB.db.prepare("SELECT * FROM people_findings").all()), /Synthetic Integration|integration-published@/);
});
