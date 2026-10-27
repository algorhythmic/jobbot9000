// Synthetic offline discovery-loop contract; no transport uses the network.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCompanies, allowedUrl, memoryReadLedger } from "../src/discovery.ts";
const TMP = mkdtempSync(join(tmpdir(), "jb-loop-"));
const PRIVATE = join(TMP, ".private", "state");
mkdirSync(PRIVATE, { recursive: true });
let pass = 0;
const test = async (name, body) => { await body(); pass++; console.log(`PASS ${name}`); };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("network prohibited in synthetic discovery loop test"); };
const START = Date.parse("2026-10-27T00:00:00Z");
const policy = (host = "careers.example") => ({ host, allowed: true, operations: ["discover", "resolve", "jobs"], policyRef: `https://${host}/terms`, checkedAt: START - 1000, expiresAt: START + 86400000 });
let seq = 0;
function fixture(custom = {}) {
  let tick = START, calls = [], saves = 0;
  const id = `synthetic_${seq++}`;
  const file = (key) => join(PRIVATE, `${key}.json`);
  const store = {
    load(key) { try { return JSON.parse(readFileSync(file(key), "utf8")); } catch { return undefined; } },
    save(run) { saves++; writeFileSync(file(run.id), JSON.stringify(run)); },
  };
  const companies = [{ name: "Synthetic A", domain: "a.example" }];
  const adapter = {
    fixtureOnly: true,
    url(phase, company, cursor) { return `https://careers.example/${phase}${company ? `/${company.domain}` : ""}${cursor ? `?page=${cursor}` : ""}`; },
    async read(url) {
      calls.push(url);
      if (custom.read) return custom.read(url, calls.length);
      const path = new URL(url).pathname;
      return { status: 200, body: path === "/discover" ? { companies } : path.startsWith("/resolve") ? { boardUrl: "https://careers.example/jobs/a.example" } : { jobs: [{ url: "https://careers.example/role/1", title: "Synthetic role" }] } };
    },
    companies(body) { return { items: body.companies ?? [], next: body.next }; },
    resolved(body, company) { return { ...company, boardUrl: body.boardUrl }; },
    jobs(body) { return { items: body.jobs ?? [], next: body.next }; },
  };
  const deps = { adapter, store, ledger: memoryReadLedger(), policies: [policy()], random: () => 0, now: () => tick, sleep: async (ms) => { tick += ms; }, ...custom.deps };
  return { id, deps, calls, companies, store, saves: () => saves, now: () => tick };
}
try {
  await test("default preview has zero adapters/state/limiter calls", async () => {
    const f = fixture();
    assert.equal((await discoverCompanies({ id: f.id }, f.deps)).dry_run, true);
    assert.equal(f.calls.length, 0); assert.equal(f.saves(), 0);
    assert.equal((await discoverCompanies({ id: "no_dependencies" })).dry_run, true);
  });
  await test("bounds clamp to company25/request100/day500", async () => {
    assert.deepEqual((await discoverCompanies({ id: "bounds", maxCompanies: 500, maxRequests: 5000, maxDailyRequests: 5000 })).limits, { companies: 25, requests: 100, daily: 500 });
    await assert.rejects(discoverCompanies({ id: "bad", maxRequests: 0 }), /bound/);
    await assert.rejects(discoverCompanies({ id: "../escape" }), /run ID/);
  });
  await test("execution requires explicit fixture adapters", async () => {
    await assert.rejects(discoverCompanies({ id: "disabled", execute: true }), /synthetic/);
    const f = fixture(); f.deps.adapter.fixtureOnly = false;
    await assert.rejects(discoverCompanies({ id: f.id, execute: true }, f.deps), /synthetic/);
  });
  await test("source policy gates allowlisted current exact hosts and operations", async () => {
    assert.equal(allowedUrl("https://careers.example/jobs", "jobs", [policy()], START).hostname, "careers.example");
    for (const p of [{ ...policy(), allowed: false }, { ...policy(), expiresAt: START }, { ...policy(), checkedAt: START + 1 }, { ...policy(), operations: ["discover"] }, { ...policy(), policyRef: "" }, { ...policy(), checkedAt: NaN }, { ...policy(), expiresAt: NaN }, { ...policy(), checkedAt: -1 }])
      assert.throws(() => allowedUrl("https://careers.example/jobs", "jobs", [p], START), /policy/);
    assert.throws(() => allowedUrl("https://other.example/jobs", "jobs", [policy()], START), /policy/);
  });
  await test("URL gate blocks private literals, localhost, LinkedIn, login and credentials", async () => {
    for (const url of ["http://careers.example/jobs", "https://127.0.0.1/", "https://0x7f000001/", "https://[::1]/", "https://10.0.0.1/", "https://localhost/", "https://intranet.local/", "https://linkedin.com/jobs", "https://www.linkedin.com/jobs", "https://careers.example/login", "https://careers.example/%6cogin", "https://careers.example/captcha/solve", "https://u:p@careers.example/jobs"])
      assert.throws(() => allowedUrl(url, "jobs", [policy(new URL(url).hostname)], START));
  });
  await test("discover resolve fetch persist provenance and provided score", async () => {
    const f = fixture({ deps: { score: (_c, jobs) => jobs.length * 2 } });
    const result = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(result.run.status, "completed"); assert.equal(f.calls.length, 3);
    assert.equal(result.run.companies[0].score, 2);
    assert.equal(result.run.companies[0].provenance.length, 3);
    assert.equal(result.run.companies[0].provenance[0].confidence, "source_reported");
    assert.equal(result.run.companies[0].provenance[0].staleAfter, START + 86400000);
    assert.deepEqual(f.store.load(f.id), result.run);
  });
  await test("missing score callback invents no score", async () => {
    const f = fixture(); const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(Object.hasOwn(run.companies[0], "score"), false);
  });
  await test("paginated discovery/jobs normalize domains and deduplicate", async () => {
    const f = fixture({ read: (url) => {
      const u = new URL(url);
      if (u.pathname === "/discover") return { status: 200, body: { companies: [{ name: "A", domain: " A.EXAMPLE " }], ...(u.search ? {} : { next: "2" }) } };
      if (u.pathname.startsWith("/resolve")) return { status: 200, body: {} };
      return { status: 200, body: { jobs: [{ url: "https://careers.example/role/1", title: "One" }, { url: "https://careers.example/role/1", title: "Duplicate" }], ...(u.search ? {} : { next: "2" }) } };
    } });
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "completed"); assert.equal(run.companies.length, 1); assert.equal(run.companies[0].company.domain, "a.example");
    assert.equal(run.companies[0].jobs.length, 1); assert.equal(run.requests, 5);
  });
  await test("empty discovery terminates with no_results", async () => {
    const f = fixture(); f.companies.length = 0;
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "no_results"); assert.equal(run.reason, "no_candidates");
    assert.equal(f.calls.length, 1);
  });
  await test("company cap stops expansion at25", async () => {
    const f = fixture(); f.companies.push(...Array.from({ length: 40 }, (_, i) => ({ name: `Synthetic${i}`, domain: `s${i}.example` })));
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.companies.length, 25); assert.equal(run.requests, 51);
  });
  await test("run budget stops before next adapter call", async () => {
    const f = fixture(); const { run } = await discoverCompanies({ id: f.id, execute: true, maxRequests: 1 }, f.deps);
    assert.equal(run.status, "stopped"); assert.match(run.reason, /run request budget/); assert.equal(f.calls.length, 1);
  });
  await test("shared daily budget blocks across runs", async () => {
    const f = fixture(); await discoverCompanies({ id: f.id, execute: true, maxDailyRequests: 2 }, f.deps);
    const { run } = await discoverCompanies({ id: `${f.id}_next`, execute: true, maxDailyRequests: 2 }, f.deps);
    assert.match(run.reason, /daily request budget/); assert.equal(f.calls.length, 2);
  });
  await test("same-domain limiter allows one inflight with one-second spacing", async () => {
    const ledger = memoryReadLedger(); let tick = START, granted = false;
    const now = () => tick, sleep = async (ms) => { tick += ms; };
    const first = await ledger.acquire("careers.example", now, sleep, 500);
    const waiting = ledger.acquire("careers.example", now, sleep, 500).then((release) => { granted = true; return release; });
    await Promise.resolve(); assert.equal(granted, false);
    first(); const second = await waiting; assert.equal(tick, START + 1000); second();
  });
  await test("429 honors Retry-After and retries at most twice", async () => {
    const f = fixture({ read: () => ({ status: 429, retryAfterSeconds: 3 }) });
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.match(run.reason, /retry limit/); assert.equal(f.calls.length, 3); assert.ok(f.now() >= START + 6000);
  });
  await test("403 fails closed with no retries", async () => {
    const f = fixture({ read: () => ({ status: 403 }) });
    assert.match((await discoverCompanies({ id: f.id, execute: true }, f.deps)).run.reason, /403/); assert.equal(f.calls.length, 1);
  });
  await test("redirect destination is checked before read", async () => {
    const f = fixture({ read: () => ({ status: 302, redirect: "https://127.0.0.1/private" }) });
    assert.match((await discoverCompanies({ id: f.id, execute: true }, f.deps)).run.reason, /host/); assert.equal(f.calls.length, 1);
  });
  await test("redirects capped at two", async () => {
    const f = fixture({ read: () => ({ status: 302, redirect: "/again" }) });
    assert.match((await discoverCompanies({ id: f.id, execute: true }, f.deps)).run.reason, /redirect limit/); assert.equal(f.calls.length, 3);
  });
  await test("request timeout stops bounded run", async () => {
    const f = fixture({ read: () => new Promise(() => {}) });
    assert.match((await discoverCompanies({ id: f.id, execute: true, timeoutMs: 1 }, f.deps)).run.reason, /timeout/); assert.equal(f.calls.length, 3);
  });
  await test("cancellation checkpoints cursor and resumes persisted run", async () => {
    const f = fixture(); const controller = new AbortController();
    const read = f.deps.adapter.read;
    f.deps.adapter.read = async (...args) => { const response = await read(...args); controller.abort(); return response; };
    const stopped = await discoverCompanies({ id: f.id, execute: true, signal: controller.signal }, f.deps);
    assert.equal(stopped.run.status, "cancelled");
    f.deps.adapter.read = read;
    const resumed = await discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps);
    assert.equal(resumed.run.status, "completed"); assert.equal(resumed.run.requests, 4);
    const before = f.calls.length;
    await discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps);
    assert.equal(f.calls.length, before);
  });
  await test("manual company starts at resolve without discovery read", async () => {
    const f = fixture(); const { run } = await discoverCompanies({ id: f.id, execute: true, companies: [{ name: "Manual Synthetic", domain: "a.example" }] }, f.deps);
    assert.equal(run.status, "completed"); assert.equal(f.calls.length, 2); assert.equal(f.calls.some((url) => new URL(url).pathname === "/discover"), false);
  });
  await test("completed stale run refreshes only on explicit request", async () => {
    const f = fixture(); const first = await discoverCompanies({ id: f.id, execute: true, ttlMs: 1 }, f.deps);
    f.deps.now = () => START + 100000;
    const before = f.calls.length;
    await discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps);
    assert.equal(f.calls.length, before);
    const refreshed = await discoverCompanies({ id: f.id, execute: true, resume: true, refreshStale: true }, f.deps);
    assert.equal(refreshed.run.status, "completed"); assert.ok(f.calls.length > before);
    assert.notEqual(refreshed.run.companies[0].provenance[0].fetchedAt, first.run.companies[0].provenance[0].fetchedAt);
  });
  await test("abort immediately stops even adapter ignoring signal", async () => {
    const controller = new AbortController();
    const f = fixture({ read: () => { queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
    const before = Date.now();
    const result = await discoverCompanies({ id: f.id, execute: true, signal: controller.signal, timeoutMs: 30000 }, f.deps);
    assert.equal(result.run.status, "cancelled"); assert.ok(Date.now() - before < 1000); assert.equal(f.calls.length, 1);
  });
  await test("existing run cannot be overwritten without explicit resume", async () => {
    const f = fixture(); await discoverCompanies({ id: f.id, execute: true }, f.deps);
    const before = f.calls.length;
    await assert.rejects(discoverCompanies({ id: f.id, execute: true }, f.deps), /already exists/); assert.equal(f.calls.length, before);
  });
  await test("transient429 recovers after bounded Retry-After", async () => {
    const f = fixture(); const normal = f.deps.adapter.read;
    let once = false;
    f.deps.adapter.read = async (...args) => { if (!once) { once = true; return { status: 429, retryAfterSeconds: 2 }; } return normal(...args); };
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "completed"); assert.equal(run.requests, 4); assert.ok(f.now() >= START + 4000);
  });
  await test("persistent503 uses at most three safe attempts", async () => {
    const f = fixture({ read: () => ({ status: 503 }) });
    assert.match((await discoverCompanies({ id: f.id, execute: true }, f.deps)).run.reason, /retry limit/); assert.equal(f.calls.length, 3);
  });
  await test("excessive Retry-After fails closed", async () => {
    const f = fixture({ read: () => ({ status: 429, retryAfterSeconds: 86400 }) });
    assert.match((await discoverCompanies({ id: f.id, execute: true }, f.deps)).run.reason, /Retry-After/); assert.equal(f.calls.length, 1);
  });
  await test("redirect to unreviewed public host is blocked before read", async () => {
    const f = fixture({ read: () => ({ status: 302, redirect: "https://other.example/discover" }) });
    assert.match((await discoverCompanies({ id: f.id, execute: true }, f.deps)).run.reason, /policy/); assert.equal(f.calls.length, 1);
  });
  await test("stale source policy is rechecked on every request", async () => {
    const f = fixture(); f.deps.policies[0].expiresAt = START + 1;
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "stopped"); assert.match(run.reason, /stale/);
    assert.equal(f.calls.length, 1); assert.equal(run.requests, 1);
  });
  await test("job references cannot smuggle prohibited destination URLs", async () => {
    const f = fixture(); f.deps.adapter.jobs = () => ({ items: [{ url: "https://linkedin.com/jobs/1", title: "Synthetic" }] });
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "stopped"); assert.match(run.reason, /host/); assert.equal(run.companies[0].jobs.length, 0);
  });
  await test("nonfinite supplied score is rejected instead of invented", async () => {
    const f = fixture({ deps: { score: () => NaN } });
    assert.match((await discoverCompanies({ id: f.id, execute: true }, f.deps)).run.reason, /score/);
  });
  await test("invalid policy check timestamp fails closed", async () => {
    for (const now of [NaN, Infinity, -1, 0.5]) assert.throws(() => allowedUrl("https://careers.example/jobs", "jobs", [policy()], now), /timestamp/);
  });
  await test("empty no_results run has TTL and supports explicit stale refresh", async () => {
    const f = fixture(); f.companies.length = 0;
    await discoverCompanies({ id: f.id, execute: true, ttlMs: 1 }, f.deps);
    f.deps.now = () => START + 100000;
    const before = f.calls.length;
    await discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps);
    assert.equal(f.calls.length, before);
    f.companies.push({ name: "Later Synthetic", domain: "a.example" });
    const { run } = await discoverCompanies({ id: f.id, execute: true, resume: true, refreshStale: true }, f.deps);
    assert.equal(run.status, "completed"); assert.ok(f.calls.length > before);
  });
  await test("manual run refresh preserves manual source input", async () => {
    const f = fixture();
    await discoverCompanies({ id: f.id, execute: true, ttlMs: 1, companies: [{ name: "Manual Synthetic", domain: "a.example" }] }, f.deps);
    f.deps.now = () => START + 100000;
    const { run } = await discoverCompanies({ id: f.id, execute: true, resume: true, refreshStale: true }, f.deps);
    assert.equal(run.status, "completed"); assert.equal(run.companies[0].company.name, "Manual Synthetic");
    assert.equal(f.calls.some((url) => new URL(url).pathname === "/discover"), false);
    assert.equal(f.calls.length, 4);
  });
  await test("missing resume run rejected before reads", async () => {
    const f = fixture(); await assert.rejects(discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps), /not found/); assert.equal(f.calls.length, 0);
  });
  await test("source policy expiring while queued blocks the first read", async () => {
    let tick = START;
    const f = fixture({ deps: { now: () => tick, ledger: { async acquire() { tick += 2000; return () => {}; } } } });
    f.deps.policies[0].expiresAt = START + 1000;
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "stopped"); assert.match(run.reason, /stale/);
    assert.equal(f.calls.length, 0); assert.equal(run.requests, 0);
  });
  await test("shared host slot remains held throughout Retry-After cooldown", async () => {
    let tick = START, enterCooldown, endCooldown, firstCooldown = true, granted = false;
    const entered = new Promise((resolve) => { enterCooldown = resolve; });
    const cooldown = new Promise((resolve) => { endCooldown = resolve; });
    const ledger = memoryReadLedger();
    const sleep = async (ms) => {
      if (ms === 3000 && firstCooldown) { firstCooldown = false; enterCooldown(); await cooldown; }
      tick += ms;
    };
    const now = () => tick;
    const f = fixture({ read: () => ({ status: 429, retryAfterSeconds: 3 }), deps: { ledger, sleep, now } });
    const running = discoverCompanies({ id: f.id, execute: true }, f.deps);
    await entered;
    const waiting = ledger.acquire("careers.example", now, sleep, 500).then((release) => { granted = true; return release; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(granted, false);
    endCooldown();
    const release = await waiting;
    assert.ok(tick >= START + 3000); release();
    const { run } = await running;
    assert.match(run.reason, /retry limit/); assert.equal(f.calls.length, 3);
  });
  await test("malformed HTTP status fails closed before result parsing", async () => {
    for (const status of [NaN, Infinity, 0, 600, 200.5, "200", undefined]) {
      const f = fixture({ read: () => ({ status }) });
      const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
      assert.equal(run.status, "stopped"); assert.match(run.reason, /invalid source HTTP status/);
      assert.equal(f.calls.length, 1); assert.equal(run.companies.length, 0);
    }
  });
  await test("unknown or corrupt persisted state is never reset or read", async () => {
    for (const patch of [{ status: "unknown" }, { phase: "unexpected" }, { companyIndex: -1 }, { companyIndex: 2 }, { requests: -1 }, { requests: null }, { updatedAt: -1 }, { ttlMs: 0 }, { cursor: {} }]) {
      const f = fixture();
      const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
      f.store.save({ ...run, ...patch });
      const calls = f.calls.length, saves = f.saves();
      await assert.rejects(discoverCompanies({ id: f.id, execute: true, resume: true, refreshStale: true }, f.deps), /invalid persisted/);
      assert.equal(f.calls.length, calls); assert.equal(f.saves(), saves);
      assert.deepEqual(f.store.load(f.id), { ...run, ...patch });
    }
  });
  await test("manual deduplication precedes the company cap", async () => {
    const f = fixture();
    const companies = Array.from({ length: 25 }, () => ({ name: "Duplicate Synthetic", domain: " A.EXAMPLE " }));
    companies.push({ name: "Second Synthetic", domain: "b.example" });
    const { run } = await discoverCompanies({ id: f.id, execute: true, companies }, f.deps);
    assert.equal(run.status, "completed"); assert.equal(run.companies.length, 2);
    assert.deepEqual(run.companies.map((c) => c.company.domain), ["a.example", "b.example"]);
    assert.equal(f.calls.length, 4);
  });
  await test("resolver cannot silently replace canonical company identity", async () => {
    const f = fixture();
    f.deps.adapter.resolved = (_body, company) => { company.domain = "different.example"; return company; };
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "stopped"); assert.match(run.reason, /identity mismatch/);
    assert.equal(run.companies[0].company.domain, "a.example"); assert.equal(f.calls.length, 2);
  });
  await test("resolver normalizes equivalent domain identity", async () => {
    const f = fixture(); f.deps.adapter.resolved = (_body, company) => ({ ...company, domain: " A.EXAMPLE " });
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.equal(run.status, "completed"); assert.equal(run.companies[0].company.domain, "a.example");
  });
  await test("unsupported persisted schema versions require explicit recovery", async () => {
    for (const version of [undefined, 0, 2]) {
      const f = fixture(); const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
      const corrupt = { ...run, schemaVersion: version }; f.store.save(corrupt);
      const calls = f.calls.length, saves = f.saves();
      await assert.rejects(discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps), /unsupported persisted discovery schema/);
      assert.equal(f.calls.length, calls); assert.equal(f.saves(), saves);
    }
  });
  await test("corrupt nested persisted data fails before any read or write", async () => {
    for (const patch of [
      { jobs: "bad" }, { jobs: [{ url: 42, title: "Synthetic" }] }, { provenance: "bad" },
      { provenance: [{ url: "https://careers.example/jobs", confidence: "source_reported", fetchedAt: START, staleAfter: START - 1 }] },
      { company: { name: "Synthetic", domain: " A.EXAMPLE " } }, { company: { name: "Synthetic", domain: "a.example", boardUrl: {} } },
      { score: "bad" }, { jobs: Array.from({ length: 1001 }, () => ({ url: "https://careers.example/jobs/1", title: "Synthetic" })) },
    ]) {
      const f = fixture(); const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
      f.store.save({ ...run, status: "stopped", phase: "jobs", companyIndex: 0, companies: [{ ...run.companies[0], ...patch }] });
      const calls = f.calls.length, saves = f.saves();
      await assert.rejects(discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps), /invalid persisted/);
      assert.equal(f.calls.length, calls); assert.equal(f.saves(), saves);
    }
  });
  await test("corrupt manual input and persisted bounds are not reset", async () => {
    for (const patch of [{ inputCompanies: [null] }, { inputCompanies: "bad" }, { requests: 101 }, { ttlMs: 30 * 86400000 + 1 }]) {
      const f = fixture(); const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
      f.store.save({ ...run, ...patch }); const calls = f.calls.length, saves = f.saves();
      await assert.rejects(discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps), /invalid persisted/);
      assert.equal(f.calls.length, calls); assert.equal(f.saves(), saves);
    }
  });
  await test("invalid manual inputs fail before persistence or adapter calls", async () => {
    for (const companies of ["bad", [null], [{ name: "", domain: "a.example" }], [{ name: "Synthetic", domain: 42 }], [{ name: "Synthetic", domain: " " }], [{ name: "Synthetic", domain: "a.example", boardUrl: {} }]]) {
      const f = fixture(); let loads = 0;
      f.deps.store.load = () => { loads++; return undefined; };
      await assert.rejects(discoverCompanies({ id: f.id, execute: true, companies }, f.deps), /invalid manual/);
      assert.equal(f.calls.length, 0); assert.equal(f.saves(), 0); assert.equal(loads, 0);
    }
  });
  await test("persisted manual targets are normalized deduplicated and capped", async () => {
    const f = fixture();
    const companies = [{ name: "Duplicate", domain: " A.EXAMPLE " }, { name: "Duplicate2", domain: "a.example" },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `Synthetic ${i}`, domain: `s${i}.example` }))];
    const { run } = await discoverCompanies({ id: f.id, execute: true, companies }, f.deps);
    assert.equal(run.inputCompanies.length, 25); assert.equal(run.companies.length, 25);
    assert.equal(run.inputCompanies[0].domain, "a.example");
    assert.equal(new Set(run.inputCompanies.map((c) => c.domain)).size, 25);
  });
  await test("resume preserves original TTL for newly fetched provenance", async () => {
    const f = fixture(); const normal = f.deps.adapter.read;
    let once = true;
    f.deps.adapter.read = async (...args) => { if (once) { once = false; return { status: 403 }; } return normal(...args); };
    const first = await discoverCompanies({ id: f.id, execute: true, ttlMs: 1234 }, f.deps);
    assert.equal(first.run.status, "stopped");
    const { run } = await discoverCompanies({ id: f.id, execute: true, resume: true }, f.deps);
    assert.equal(run.status, "completed"); assert.equal(run.ttlMs, 1234);
    for (const company of run.companies) for (const p of company.provenance) assert.equal(p.staleAfter - p.fetchedAt, 1234);
  });
  await test("absent Retry-After uses deterministic exponential jitter", async () => {
    let tick = START; const sleeps = [];
    const f = fixture({ read: () => ({ status: 503 }), deps: { random: () => 0.5, now: () => tick, sleep: async (ms) => { sleeps.push(ms); tick += ms; } } });
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.match(run.reason, /retry limit/); assert.deepEqual(sleeps, [2500, 4500]);
  });
  await test("explicit Retry-After never samples jitter", async () => {
    const f = fixture({ read: () => ({ status: 429, retryAfterSeconds: 2 }), deps: { random: () => { throw new Error("must not sample jitter"); } } });
    const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
    assert.match(run.reason, /retry limit/); assert.equal(f.calls.length, 3);
  });
  await test("invalid injected jitter fails closed", async () => {
    for (const random of [() => NaN, () => -1, () => 1.01]) {
      const f = fixture({ read: () => ({ status: 503 }), deps: { random } });
      const { run } = await discoverCompanies({ id: f.id, execute: true }, f.deps);
      assert.match(run.reason, /invalid backoff random/); assert.equal(f.calls.length, 1);
    }
  });
  console.log(`\n${pass} passed, 0 failed`);
} finally { globalThis.fetch = originalFetch; rmSync(TMP, { recursive: true, force: true }); }
