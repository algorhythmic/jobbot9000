// Synthetic, injected replies only; no DB, credentials, environment or live reads.
import test from "node:test";
import assert from "node:assert/strict";
import { atsFixtureAdapter } from "../src/discovery-ats.ts";
import { discoverCompanies, memoryReadLedger } from "../src/discovery.ts";
import { normalizeAtsBoard } from "../src/ats.ts";

const boards = [
  ["greenhouse", "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs?content=true", { jobs: [
    { absolute_url: "https://jobs.synthetic.example/greenhouse-1", title: "Synthetic engineer" },
    { absolute_url: "https://jobs.synthetic.example/greenhouse-1", title: "Duplicate reference" },
  ] }],
  ["lever", "https://api.lever.co/v0/postings/synthetic?mode=json", [
    { hostedUrl: "https://jobs.synthetic.example/lever-1", text: "Synthetic engineer", categories: { location: "Remote" } },
  ]],
  ["ashby", "https://api.ashbyhq.com/posting-api/job-board/synthetic?includeCompensation=true", { jobs: [
    { jobUrl: "https://jobs.synthetic.example/ashby-1", title: "Synthetic engineer", isRemote: true },
  ] }],
  ["workable", "https://apply.workable.com/api/v1/widget/accounts/synthetic?details=true", { jobs: [
    { url: "https://jobs.synthetic.example/workable-1", title: "Synthetic engineer", city: "Synthetic city", telecommuting: true },
  ] }],
];

function setup(boardUrl, payload) {
  let clock = 10000;
  const calls = [];
  const leadUrl = "https://leads.synthetic.example/page-1";
  const replies = new Map([
    [leadUrl, { status: 200, body: { companies: [{ name: "Synthetic Company", domain: "company.synthetic.example" }] } }],
    ["https://company.synthetic.example/careers", { status: 200, body: { boardUrl } }],
    [boardUrl, { status: 200, body: payload }],
  ]);
  const adapter = atsFixtureAdapter({ leadUrl, read: async (url, signal) => {
    assert.equal(signal.aborted, false);
    calls.push(url);
    assert.ok(replies.has(url), `unexpected synthetic read: ${url}`);
    return structuredClone(replies.get(url));
  } });
  const state = new Map();
  const hosts = ["leads.synthetic.example", "company.synthetic.example", new URL(boardUrl).hostname, "jobs.synthetic.example"];
  const deps = {
    adapter, ledger: memoryReadLedger(), now: () => clock, sleep: async (ms) => { clock += ms; },
    store: { load: (id) => state.get(id), save: (run) => state.set(run.id, structuredClone(run)) },
    policies: hosts.map((host) => ({ host, allowed: true, operations: ["discover", "resolve", "jobs"], policyRef: "https://policy.synthetic.example/terms", checkedAt: 0, expiresAt: 100000 })),
  };
  return { deps, calls, replies };
}

for (const [platform, url, payload] of boards) {
  test(`${platform}: official-shaped fixture passes through gated loop and normalizes job references`, async () => {
    const { deps, calls } = setup(url, payload);
    const result = await discoverCompanies({ id: platform, execute: true }, deps);
    assert.equal(result.run.status, "completed");
    assert.equal(result.run.companies[0].company.boardUrl, url);
    assert.deepEqual(result.run.companies[0].jobs, [{ url: `https://jobs.synthetic.example/${platform}-1`, title: "Synthetic engineer" }]);
    assert.equal(result.run.companies[0].provenance.length, 3);
    assert.equal(result.run.requests, 3);
    assert.equal(calls.length, 3, "no hidden probes or application reads");
  });
}

test("empty valid ATS board completes without invented postings", async () => {
  const { deps } = setup(boards[0][1], { jobs: [] });
  const result = await discoverCompanies({ id: "empty", execute: true }, deps);
  assert.equal(result.run.status, "completed");
  assert.deepEqual(result.run.companies[0].jobs, []);
});

test("malformed ATS board stops explicitly instead of recording an empty board", async () => {
  const { deps } = setup(boards[0][1], { postings: [] });
  const result = await discoverCompanies({ id: "malformed", execute: true }, deps);
  assert.equal(result.run.status, "stopped");
  assert.match(result.run.reason, /malformed ATS fixture board/);
});

test("unsupported board hosts fail before any board read", async () => {
  const { deps, calls } = setup("https://www.linkedin.com/jobs/synthetic", { jobs: [] });
  const result = await discoverCompanies({ id: "unsupported", execute: true }, deps);
  assert.equal(result.run.status, "stopped");
  assert.match(result.run.reason, /unsupported pinned ATS board endpoint/);
  assert.equal(calls.length, 2);
});

test("dry run and missing board policy perform zero and two injected reads respectively", async () => {
  const { deps, calls } = setup(boards[0][1], boards[0][2]);
  assert.equal((await discoverCompanies({ id: "dry" }, deps)).dry_run, true);
  assert.equal(calls.length, 0);
  deps.policies = deps.policies.filter((p) => p.host !== "boards-api.greenhouse.io");
  const result = await discoverCompanies({ id: "denied", execute: true }, deps);
  assert.equal(result.run.status, "stopped");
  assert.match(result.run.reason, /source policy missing or stale/);
  assert.equal(calls.length, 2);
});

test("pure ATS parser preserves empty versus malformed distinction for all platforms", () => {
  for (const [platform] of boards) {
    assert.deepEqual(normalizeAtsBoard(platform, platform === "lever" ? [] : { jobs: [] }), []);
    assert.equal(normalizeAtsBoard(platform, null), null);
  }
});

test("manual company pins the board and reuses the same policy-gated phases", async () => {
  const { deps, calls, replies } = setup(boards[1][1], boards[1][2]);
  replies.set("https://company.synthetic.example/careers", { status: 200, body: {} });
  const result = await discoverCompanies({ id: "manual", execute: true, companies: [
    { name: "Synthetic Company", domain: "company.synthetic.example", boardUrl: boards[1][1] },
  ] }, deps);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.companies[0].jobs.length, 1);
  assert.deepEqual(calls, ["https://company.synthetic.example/careers", boards[1][1]]);
});

test("invalid lead page stops after its single injected read", async () => {
  const { deps, calls, replies } = setup(boards[0][1], boards[0][2]);
  replies.set("https://leads.synthetic.example/page-1", { status: 200, body: { companies: [{ name: "Synthetic" }] } });
  const result = await discoverCompanies({ id: "bad-lead", execute: true }, deps);
  assert.equal(result.run.status, "stopped");
  assert.match(result.run.reason, /invalid fixture company/);
  assert.equal(calls.length, 1);
});

test("official-host lookalikes and non-board endpoints are never accepted", () => {
  const { deps } = setup(boards[0][1], boards[0][2]);
  for (const boardUrl of [
    "https://boards-api.greenhouse.io.evil.example/v1/boards/synthetic/jobs",
    "http://boards-api.greenhouse.io/v1/boards/synthetic/jobs",
    "https://user:secret@boards-api.greenhouse.io/v1/boards/synthetic/jobs",
    "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs/submit",
    "https://boards-api.greenhouse.io:8443/v1/boards/synthetic/jobs",
  ]) assert.throws(() => deps.adapter.resolved({ boardUrl }, { name: "Synthetic", domain: "company.synthetic.example" }), /unsupported pinned/);
});
