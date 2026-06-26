// Offline test for find_companies — the ATS resolver, the TheirStack provider, the
// curated (free, default) provider, the on-demand path, and the gather orchestration —
// all against a MOCKED fetch: no network, no API key, no spend. Run via `npm test`
// (tsx executes it against src/ directly; no build step needed).
//
// State is isolated to a temp STATE_DIR and a temp JOBBOT_SEEDS_FILE, both set BEFORE
// the modules load (db.ts opens its SQLite DB on import), so this never touches the real
// database or the tracked seeds/companies.json. Dynamic imports are used for that reason.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TMP = mkdtempSync(join(tmpdir(), "jbdisc-"));
process.env.STATE_DIR = TMP;
const SEEDS = join(TMP, "seeds.json");
process.env.JOBBOT_SEEDS_FILE = SEEDS;
writeFileSync(SEEDS, "[]"); // start empty

const src = (f) => new URL(`../src/${f}`, import.meta.url).href;
const ats = await import(src("ats.ts"));
const prov = await import(src("providers.ts"));
const tools = await import(src("tools.ts"));
const DB = await import(src("db.ts"));

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const jres = (r) => JSON.parse(r.content[0].text);

// ── mock fetch builders ──────────────────────────────────────────────────────
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });
// ATS mock: greenhouse 'acme' valid (2 jobs); ashby 'emptyco' empty-but-valid; else 404.
const atsFetch = async (url) => {
  if (url.includes("boards-api.greenhouse.io/v1/boards/acme/")) return ok({ jobs: [{ absolute_url: "https://acme/1", title: "A" }, { absolute_url: "https://acme/2", title: "B" }] });
  if (url.includes("api.ashbyhq.com/posting-api/job-board/emptyco")) return ok({ jobs: [] });
  return notFound();
};
const atsResolve = (c) => ats.resolveAts(c, { fetchFn: atsFetch });

// ── A. ATS resolver + slug candidates ────────────────────────────────────────
eq(ats.slugCandidates("Acme Inc", "https://www.acme.com/careers").map((c) => `${c.slug}:${c.via}`),
   ["acme:domain", "acmeinc:name"], "slugCandidates: domain first; name fallback deduped");
eq(await atsResolve({ name: "Acme", domain: "acme.com" }),
   { platform: "greenhouse", slug: "acme", job_count: 2, via: "domain" }, "resolveAts: greenhouse hit via domain");
eq(await atsResolve({ name: "EmptyCo", domain: "emptyco.com" }),
   { platform: "ashby", slug: "emptyco", job_count: 0, via: "domain" }, "resolveAts: empty-but-valid = resolved");
eq(await atsResolve({ name: "Ghost", domain: "ghost.com" }), null, "resolveAts: miss -> null (not throw)");

// ── B. TheirStack provider direct (estimate free + discover paid) ─────────────
let lastBody = null;
const tsFetch = async (url, init) => {
  const body = JSON.parse(init.body); lastBody = body;
  if (body.limit === 0) return ok({ data: [], metadata: { total_results: 120 } }); // free count
  return ok({ data: [
    { company: "Acme", company_domain: "acme.com" },
    { company: "Acme", company_domain: "acme.com" },   // dup posting
    { company: "Beta", company_domain: "beta.io" },
    { company: "NoDomainCo" },                          // name only
  ] });
};
const tsCtx = { apiKey: "test-key", fetchFn: tsFetch };
const est = await prov.theirstackProvider.estimate({ titles: ["SWE"], limit: 25 }, tsCtx);
eq([est.total_matches, est.projected_records, est.projected_credits, est.free], [120, 25, 25, true], "ts.estimate: free count, spend bounded by limit");
eq(lastBody.property_exists_or, ["domain"], "ts.estimate: always requires domain");
eq(lastBody.limit, 0, "ts.estimate: zero-record (free) call");
const disc = await prov.theirstackProvider.discover({ titles: ["SWE"], limit: 25 }, tsCtx);
eq([disc.records_billed, disc.companies.map((c) => c.domain).sort().join("|")], [4, "acme.com|beta.io|"], "ts.discover: billed per record; deduped to unique companies");

// ── C. Curated provider (FREE, default) ──────────────────────────────────────
eq(Object.keys(prov.PROVIDERS)[0], "curated", "registry: default provider is 'curated' (free)");
eq((await prov.curatedProvider.discover({}, {})).companies.length, 0, "curated: empty roster -> no companies");
eq((await prov.curatedProvider.estimate({}, {})).projected_credits, 0, "curated: estimate is free (0 credits)");
writeFileSync(SEEDS, JSON.stringify([
  { name: "Acme", domain: "acme.com", ats_platform: "greenhouse", ats_slug: "acme", tags: ["industry:fintech"] },
  { name: "Delta", domain: "delta.io" },
]));
const seeded = await prov.curatedProvider.discover({}, {});
eq(seeded.companies.map((c) => `${c.name}:${c.ats_slug ?? "-"}`), ["Acme:acme", "Delta:-"], "curated: maps seeds (slug-complete + domain-only)");
writeFileSync(SEEDS, "[]"); // back to empty for the orchestration tests

// ── D. On-demand path (free, zero-config) ─────────────────────────────────────
const od = jres(await tools.findCompanies({ companies: [{ name: "Acme", domain: "acme.com" }, { name: "Ghost", domain: "ghost.com" }] }, { resolve: atsResolve }));
eq([od.ok, od.mode, od.credits_spent], [true, "on_demand", 0], "on-demand: free, no provider/key");
eq(od.persisted, { inserted: 2, resolved: 1, unresolved: 1, skipped: 0 }, "on-demand: acme resolved, ghost unresolved");
eq([DB.counts().companies, DB.counts().unresolved], [2, 1], "on-demand: persisted 2 (1 unresolved)");

// ── E. Default-is-free: no provider, empty roster -> free no-op with guidance ──
const def = jres(await tools.findCompanies({ titles: ["SWE"] }, { resolve: atsResolve }));
eq([def.ok, def.provider, def.credits_spent, def.discovered], [true, "curated", 0, 0], "default: free curated, no spend");
eq(typeof def.note === "string" && def.note.includes("companies:"), true, "default: empty roster -> guides to on-demand / seeds / theirstack");
eq(DB.counts().companies, 2, "default: empty roster persisted nothing");

// ── F. TheirStack is now opt-in (not default) ─────────────────────────────────
eq(jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"] }, { ctx: { apiKey: undefined } })).ok, false, "theirstack: explicit + no key -> ok:false (honest)");
const dry = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], dry_run: true }, { ctx: tsCtx }));
eq([dry.dry_run, dry.estimate.total_matches], [true, 120], "theirstack: dry_run -> free estimate");

// ── G. Confirmation gate: projected > ceiling without confirm -> no spend ─────
const gated = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], limit: 25, max_credits: 10 }, { ctx: tsCtx }));
eq([gated.ok, gated.confirmation_required], [false, true], "ceiling: over-budget pull blocked pending confirm");
eq(DB.counts().companies, 2, "ceiling: blocked run persisted nothing");

// ── H. Paid pull (opt-in) resolves + persists; idempotent on re-run ───────────
const run = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], limit: 25, confirm: true }, { ctx: tsCtx, resolve: atsResolve }));
eq([run.ok, run.credits_spent], [true, 4], "paid pull: ok, reports real spend");
eq(run.persisted, { inserted: 1, resolved: 1, unresolved: 1, skipped: 1 }, "paid pull: beta inserted, acme re-resolved, no-domain skipped");
eq([DB.counts().companies, DB.counts().unresolved], [3, 2], "paid pull: now 3 companies (ghost+beta unresolved)");
const rerun = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], limit: 25, confirm: true }, { ctx: tsCtx, resolve: atsResolve }));
eq(rerun.persisted.inserted, 0, "re-run: 0 net-new (idempotent persist, dedup-before-fetch)");
eq(DB.counts().companies, 3, "re-run: still 3 companies");

// ════════════════════ fetch_jobs ════════════════════
const live = (cid) => DB.db.prepare("SELECT count(*) c FROM jobs WHERE company_id=? AND still_live=1").get(cid).c;

// ── I. Board fetch + normalize (real fetchBoard, mocked HTTP) ──────────────────
const boardFetch = (frag, body) => async (url) => (url.includes(frag) ? ok(body) : notFound());
const gh = await ats.fetchBoard("greenhouse", "acmeco", boardFetch("boards/acmeco/", { jobs: [
  { absolute_url: "https://gh/1", title: "Eng", location: { name: "Remote - US" } },
  { absolute_url: "https://gh/2", title: "PM", location: { name: "NYC" } },
] }));
eq([gh.length, gh[0].source_url, gh[0].remote, gh[1].remote], [2, "https://gh/1", 1, null], "fetchBoard greenhouse: normalize + remote-from-location");
const lv = await ats.fetchBoard("lever", "x", boardFetch("api.lever.co/v0/postings/x", [
  { hostedUrl: "https://lv/1", text: "SRE", categories: { location: "Berlin" }, workplaceType: "remote" },
]));
eq([lv.length, lv[0].title, lv[0].remote], [1, "SRE", 1], "fetchBoard lever: array shape, remote flag");
eq((await ats.fetchBoard("ashby", "empty", boardFetch("job-board/empty", { jobs: [] }))).length, 0, "fetchBoard: empty-but-valid board -> []");
eq(await ats.fetchBoard("greenhouse", "nope", boardFetch("never", {})), null, "fetchBoard: 404 -> null");
eq((await ats.fetchBoard("greenhouse", "d", boardFetch("boards/d/", { jobs: [{ title: "NoUrl" }, { absolute_url: "https://d/1", title: "Ok" }] }))).length, 1, "fetchBoard: postings without source_url dropped");

// ── J. upsertJobs liveness (direct) ───────────────────────────────────────────
const cid = DB.upsertCompany({ name: "LiveCo", domain: "liveco.com", ats_platform: "greenhouse", ats_slug: "liveco" }).id;
eq(DB.upsertJobs(cid, [{ source_url: "u1", title: "A" }, { source_url: "u2", title: "B" }]), { inserted: 2, updated: 0, closed: 0, seen: 2 }, "upsertJobs: initial insert");
eq(DB.upsertJobs(cid, [{ source_url: "u1", title: "A2" }]), { inserted: 0, updated: 1, closed: 1, seen: 1 }, "upsertJobs: update u1, close vanished u2 (liveness)");
eq(live(cid), 1, "upsertJobs: only u1 live after u2 closed");
eq([DB.upsertJobs(cid, [{ source_url: "u1" }, { source_url: "u2" }]).inserted, live(cid)], [0, 2], "upsertJobs: u2 reopens (update, not insert)");
eq(DB.upsertJobs(cid, []).closed, 2, "upsertJobs: empty feed closes all live");
eq(live(cid), 0, "upsertJobs: nothing live after empty feed");

// ── K. fetchJobs orchestration (injected boards) ──────────────────────────────
const boards = { "greenhouse:newco": [{ source_url: "n1", title: "Eng" }, { source_url: "n2", title: "PM" }], "ashby:deadco": null };
const fbf = async (platform, slug) => (`${platform}:${slug}` in boards ? boards[`${platform}:${slug}`] : null);
const noSleep = async () => {};
const fd = { fetchBoardFn: fbf, sleep: noSleep, politeDelayMs: 0 };

const f1 = jres(await tools.fetchJobs({ ats_platform: "greenhouse", ats_slug: "newco" }, fd));
eq([f1.ok, f1.boards_fetched, f1.jobs.inserted], [true, 1, 2], "fetchJobs: one board by slug -> 2 jobs inserted");
eq(!!DB.getCompanyByAts("greenhouse", "newco"), true, "fetchJobs: auto-created company for a new slug");
eq(typeof f1.next === "string" && f1.next.includes("worklist"), true, "fetchJobs: next points at grading");

DB.upsertCompany({ name: "DeadCo", ats_platform: "ashby", ats_slug: "deadco" });
const f2 = jres(await tools.fetchJobs({ ats_platform: "ashby", ats_slug: "deadco" }, fd));
eq([f2.boards_fetched, f2.unreachable, f2.jobs.inserted], [0, 1, 0], "fetchJobs: unreachable board skipped, nothing persisted");

const noslug = DB.upsertCompany({ name: "NoSlug", domain: "noslug.com" }).id;
eq(jres(await tools.fetchJobs({ company_id: noslug }, fd)).ok, false, "fetchJobs: unresolved company_id -> honest error");
eq(jres(await tools.fetchJobs({ company_id: 999999 }, fd)).ok, false, "fetchJobs: missing company_id -> honest error");

const fc = jres(await tools.fetchJobs({ company_id: DB.getCompanyByAts("greenhouse", "newco").id }, fd));
eq([fc.ok, fc.jobs.updated], [true, 2], "fetchJobs: by company_id refetches (idempotent update)");

const fb = jres(await tools.fetchJobs({}, fd));
eq([fb.ok, fb.boards_fetched >= 1], [true, true], "fetchJobs: batch-all refreshes resolved companies");

// ════════════════════ ingest_portfolio ════════════════════
const githubMod = await import(src("github.ts"));

// ── L. fetchUserRepos (real, mocked HTTP) ─────────────────────────────────────
const ghRepos = [
  { full_name: "u/alpha", name: "alpha", description: "a cli", language: "TypeScript", stargazers_count: 10, forks_count: 2, topics: ["cli"], fork: false, archived: false, pushed_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/u/alpha", homepage: "https://alpha.dev" },
  { full_name: "u/forked", name: "forked", language: "Go", stargazers_count: 0, forks_count: 0, fork: true, pushed_at: "2025-01-01T00:00:00Z", html_url: "https://github.com/u/forked" },
];
const ghFetch = async (url) => (url.includes("/users/u/repos") ? ok(ghRepos) : notFound());
const facts = await githubMod.fetchUserRepos("u", { fetchFn: ghFetch });
eq([facts.length, facts[0].repo, facts[0].language, facts[0].stars, facts[0].is_fork], [2, "u/alpha", "TypeScript", 10, false], "fetchUserRepos: normalize facts");
eq([facts[1].is_fork, facts[0].topics.join(",")], [true, "cli"], "fetchUserRepos: fork flag + topics");
let threw = false; try { await githubMod.fetchUserRepos("nobody", { fetchFn: async () => notFound() }); } catch (e) { threw = /no public GitHub user/.test(e.message); }
eq(threw, true, "fetchUserRepos: 404 -> throws unknown-user");

// injectable mock returning RepoFacts directly (orchestration deps)
const mkFacts = (o) => ({ repo: "u/x", name: "x", description: null, language: "TS", stars: 0, forks: 0, topics: [], is_fork: false, is_archived: false, pushed_at: "2026-01-01", url: "u", homepage: null, ...o });
const fr = async () => [mkFacts({ repo: "u/alpha", language: "TypeScript", stars: 10 }), mkFacts({ repo: "u/forked", is_fork: true })];

// ── M. no handle (profile has none) -> honest error ───────────────────────────
eq(jres(await tools.ingestPortfolio({}, { fetchReposFn: fr })).ok, false, "ingest: no handle -> ok:false");

// ── N. no_github opt-out -> honest error, then clear ──────────────────────────
DB.upsertProfile({ no_github: 1 });
eq(jres(await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: fr })).ok, false, "ingest: no_github opt-out -> ok:false");
DB.upsertProfile({ no_github: 0 });

// ── O. happy path: forks skipped, snapshot stored, handle persisted ───────────
const ing = jres(await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: fr }));
eq([ing.ok, ing.fetched, ing.kept, ing.forks_skipped, ing.portfolio_count], [true, 2, 1, 1, 1], "ingest: fork skipped, 1 kept");
eq(DB.getPortfolio()[0].repo, "u/alpha", "ingest: stored the non-fork repo");
eq(DB.getProfile()?.github_handle, "u", "ingest: persisted the handle to the profile");

// ── P. include_forks keeps forks ─────────────────────────────────────────────
const ing2 = jres(await tools.ingestPortfolio({ github_handle: "u", include_forks: true }, { fetchReposFn: fr }));
eq([ing2.kept, ing2.portfolio_count], [2, 2], "ingest: include_forks keeps the fork");

// ── Q. replace semantics: re-ingest is a fresh snapshot (dropped repo leaves) ──
const ing3 = jres(await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: async () => [mkFacts({ repo: "u/alpha" })] }));
eq([ing3.portfolio_count, DB.getPortfolio().length], [1, 1], "ingest: snapshot replaces prior (fork dropped)");

// ── cleanup ───────────────────────────────────────────────────────────────────
try { DB.db.close(); } catch {}
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
