// Synthetic private SQLite only; no adapters, HTTP, credentials or personal input.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const fixture = mkdtempSync(join(tmpdir(), "jobbot-read-ledger-"));
process.env.JOBBOT_PRIVATE_DIR = join(fixture, ".private");
process.env.STATE_DIR = join(fixture, ".private", "state");
const DB = await import("../src/db.ts");
const { privateReadLedger } = await import("../src/discovery-ledger.ts");
after(() => { DB.db.close(); rmSync(fixture, { recursive: true, force: true }); });
let tick = Date.parse("2026-01-01T00:00:00Z");
const now = () => tick;
const sleep = async ms => { tick += ms; };
const requests = () => DB.db.prepare("SELECT SUM(requests) AS n FROM discovery_read_days").get().n ?? 0;

test("daily total persists across ledger recreation and is global across hosts", async () => {
  const first = await privateReadLedger().acquire("one.example", now, sleep, 2); first();
  const second = await privateReadLedger().acquire("two.example", now, sleep, 2); second();
  await assert.rejects(privateReadLedger().acquire("three.example", now, sleep, 2), /daily request budget/);
  assert.equal(requests(), 2);
});

test("UTC day rollover grants a new daily budget", async () => {
  tick += 86400000;
  const release = await privateReadLedger().acquire("one.example", now, sleep, 1); release();
  assert.equal(requests(), 3);
});

test("host spacing survives ledger recreation and wait consumes no budget", async () => {
  tick += 86400000;
  const first = await privateReadLedger().acquire("spacing.example", now, sleep, 10); first();
  const before = tick, total = requests();
  assert.equal(DB.reserveDiscoveryRead("spacing.example", tick, 10), 1000);
  assert.equal(requests(), total);
  const second = await privateReadLedger().acquire("spacing.example", now, sleep, 10); second();
  assert.equal(tick, before + 1000); assert.equal(requests(), total + 1);
});

test("reservation and journal roll back together on failure", () => {
  const total = requests();
  DB.db.exec("CREATE TRIGGER fail_read_journal BEFORE INSERT ON events WHEN NEW.kind='discovery_read_reserved' BEGIN SELECT RAISE(ABORT,'synthetic read failure'); END");
  try {
    assert.throws(() => DB.reserveDiscoveryRead("rollback.example", tick, 10), /synthetic read failure/);
    assert.equal(requests(), total);
    assert.equal(DB.db.prepare("SELECT * FROM discovery_read_hosts WHERE host='rollback.example'").get(), undefined);
  } finally { DB.db.exec("DROP TRIGGER fail_read_journal"); }
});

test("budget rejection releases local slot for the next day", async () => {
  const ledger = privateReadLedger();
  // Current day has two reservations from the spacing test.
  await assert.rejects(ledger.acquire("release.example", now, sleep, 1), /daily request budget/);
  tick += 86400000;
  const release = await Promise.race([
    ledger.acquire("release.example", now, sleep, 1),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("slot leaked")), 1000); timer.unref(); }),
  ]);
  release();
});

test("reservation rejects invalid hosts, timestamps and daily limits before writes", () => {
  const total = requests();
  for (const host of ["", "bad host", "HTTPS://one.example", "one.example/path"])
    assert.throws(() => DB.reserveDiscoveryRead(host, tick, 10), /host/);
  for (const time of [NaN, Infinity, -1, 0.1, 8640000000000001])
    assert.throws(() => DB.reserveDiscoveryRead("bounds.example", time, 10), /timestamp/);
  for (const limit of [0, -1, 1.1, 501, NaN, Infinity])
    assert.throws(() => DB.reserveDiscoveryRead("bounds.example", tick, limit), /bound/);
  assert.equal(requests(), total);
});

test("independent process reopening synthetic DB retains the daily total", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    const DB=await import('./src/db.ts');
    try { DB.reserveDiscoveryRead('reopened.example', ${tick}, 1); process.exitCode=2; }
    catch(error) { if(!/daily request budget exhausted/.test(error.message)) throw error; }
    finally { DB.db.close(); }
  `], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});
