// db.ts — the SQLite layer and the ONLY code that writes the database.
// Two planes live here: `personal` (local always, never shared) and `catalog`
// (public market data, the only plane sync touches). Tools call these helpers;
// the agent never issues a raw write.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// STATE_DIR is set by the plugin to ${CLAUDE_PLUGIN_DATA}/state — a persistent,
// per-plugin directory (~/.claude/plugins/data/<id>/) that survives updates. If the
// host didn't expand that variable (it arrives unset, or as a literal "${...}" — see
// claude-code issue #9427 for plugin-root .mcp.json), fall back to a STABLE absolute
// path under the home dir, NEVER a cwd-relative one (which would fragment the DB
// across sessions that start in different directories).
function resolveStateDir(): string {
  const v = process.env.STATE_DIR;
  if (!v || v.includes("${")) {
    if (v) process.stderr.write(`[jobbot9000] STATE_DIR was not expanded ("${v}") — falling back to ~/.jobbot/state\n`);
    return join(homedir(), ".jobbot", "state");
  }
  return v;
}
const STATE_DIR = resolveStateDir();
mkdirSync(STATE_DIR, { recursive: true });

export const db = new Database(join(STATE_DIR, "jobbot.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000"); // wait (don't throw SQLITE_BUSY) if another session holds the write lock

db.exec(`
-- ── personal plane — local always; never shared / synced ──────────────────
CREATE TABLE IF NOT EXISTS profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  target_role   TEXT,
  target_niche  TEXT,
  location_pref TEXT,
  github_handle TEXT,
  no_resume     INTEGER NOT NULL DEFAULT 0,
  no_github     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS master_resume (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS portfolio_projects (
  repo       TEXT PRIMARY KEY,
  facts_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assessment (              -- the user's level (judgment)
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  level         TEXT NOT NULL,
  rationale     TEXT,
  evidence_json TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS job_fit (                 -- the user's fit on a job (judgment, personal)
  job_id     INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  band       TEXT NOT NULL,
  gaps_json  TEXT,
  rationale  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cover_letters (           -- the per-role deliverable
  job_id              INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  talking_points_json TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── catalog plane — public market data; the only plane sync touches ───────
CREATE TABLE IF NOT EXISTS companies (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL,
  domain                  TEXT,
  tags                    TEXT,                              -- delimited namespaced tags, e.g. "funding:series_b,size:51-200"
  source                  TEXT,                              -- provenance: 'theirstack' | 'common_crawl' | 'manual' | ...
  ats_platform            TEXT,
  ats_slug                TEXT,
  resolved                INTEGER NOT NULL DEFAULT 1,         -- 1 = slug-complete; 0 = discovered, ATS not yet resolved
  resolve_attempts        INTEGER NOT NULL DEFAULT 0,         -- stage-4 resolution tries (skip/deprioritise repeat failures)
  last_resolve_attempt_at TEXT,
  added_at                TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at         TEXT,
  UNIQUE (ats_platform, ats_slug)
);
-- domain is the fallback dedup key for unresolved rows (whose ats_slug is NULL, and SQLite
-- treats every NULL as distinct, so UNIQUE(ats_platform, ats_slug) can't dedup them).
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_url         TEXT NOT NULL,
  title              TEXT,
  location           TEXT,
  remote             INTEGER,
  comp_min           REAL,
  comp_max           REAL,
  raw_json           TEXT,
  grade_seniority    TEXT,                            -- judgment, set by grade_job
  grade_market_signal TEXT,                           -- judgment, set by grade_job
  graded_at          TEXT,
  fetched_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
  still_live         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, source_url)
);
CREATE TABLE IF NOT EXISTS job_skills (              -- intrinsic, set by grade_job
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill  TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('required','preferred')),
  UNIQUE (job_id, skill, kind)
);
`);

// ── guarded migrations — additive columns for databases created before they existed.
// No-ops on a fresh DB (CREATE TABLE above already has them). ALTER ADD COLUMN is the
// only safe in-place change: CREATE TABLE IF NOT EXISTS won't alter a table that exists.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("companies", "resolve_attempts", "resolve_attempts INTEGER NOT NULL DEFAULT 0");
ensureColumn("companies", "last_resolve_attempt_at", "last_resolve_attempt_at TEXT");

// ── personal accessors ─────────────────────────────────────────────────────
export interface Profile {
  target_role: string | null; target_niche: string | null; location_pref: string | null;
  github_handle: string | null; no_resume: number; no_github: number;
}
export const getProfile = (): Profile | undefined =>
  db.prepare("SELECT * FROM profile WHERE id = 1").get() as Profile | undefined;

export function upsertProfile(p: Partial<Profile>): void {
  const cur = (getProfile() ?? {}) as Partial<Profile>;
  const m = { ...cur, ...p };
  db.prepare(
    `INSERT INTO profile (id, target_role, target_niche, location_pref, github_handle, no_resume, no_github, updated_at)
     VALUES (1, @target_role, @target_niche, @location_pref, @github_handle, @no_resume, @no_github, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       target_role=excluded.target_role, target_niche=excluded.target_niche,
       location_pref=excluded.location_pref, github_handle=excluded.github_handle,
       no_resume=excluded.no_resume, no_github=excluded.no_github, updated_at=datetime('now')`,
  ).run({
    target_role: m.target_role ?? null, target_niche: m.target_niche ?? null,
    location_pref: m.location_pref ?? null, github_handle: m.github_handle ?? null,
    no_resume: m.no_resume ?? 0, no_github: m.no_github ?? 0,
  });
}

export const getMasterResume = (): { content: string; updated_at: string } | undefined =>
  db.prepare("SELECT content, updated_at FROM master_resume WHERE id = 1").get() as { content: string; updated_at: string } | undefined;
export const setMasterResume = (content: string): void => {
  db.prepare(
    `INSERT INTO master_resume (id, content, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`,
  ).run(content);
};

export const getAssessment = (): { level: string; rationale: string | null; evidence: unknown } | undefined => {
  const r = db.prepare("SELECT level, rationale, evidence_json FROM assessment WHERE id = 1")
    .get() as { level: string; rationale: string | null; evidence_json: string | null } | undefined;
  return r ? { level: r.level, rationale: r.rationale, evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null } : undefined;
};

export interface PortfolioProject { repo: string; facts_json: string | null; fetched_at: string }
export const getPortfolio = (): PortfolioProject[] =>
  db.prepare("SELECT repo, facts_json, fetched_at FROM portfolio_projects").all() as PortfolioProject[];

export interface CoverLetter { content: string; talking_points: unknown[]; created_at: string }
export const getCoverLetter = (jobId: number): CoverLetter | null => {
  const r = db.prepare("SELECT content, talking_points_json, created_at FROM cover_letters WHERE job_id = ?")
    .get(jobId) as { content: string; talking_points_json: string | null; created_at: string } | undefined;
  return r ? { content: r.content, talking_points: r.talking_points_json ? JSON.parse(r.talking_points_json) : [], created_at: r.created_at } : null;
};
export const setAssessment = (level: string, rationale: string, evidence: unknown): void => {
  db.prepare(
    `INSERT INTO assessment (id, level, rationale, evidence_json, updated_at)
     VALUES (1, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET level=excluded.level, rationale=excluded.rationale,
       evidence_json=excluded.evidence_json, updated_at=datetime('now')`,
  ).run(level, rationale, JSON.stringify(evidence ?? null));
};

export const recordCoverLetter = (jobId: number, content: string, points: unknown): void => {
  db.prepare(
    `INSERT INTO cover_letters (job_id, content, talking_points_json) VALUES (?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET content=excluded.content,
       talking_points_json=excluded.talking_points_json`,
  ).run(jobId, content, JSON.stringify(points ?? null));
};

export const getMeta = (key: string): string | null =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
export const setMeta = (key: string, value: string): void => {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
};

// ── catalog accessors ──────────────────────────────────────────────────────
export interface Job {
  id: number; company_id: number; source_url: string; title: string | null; location: string | null;
  remote: number | null; comp_min: number | null; comp_max: number | null; raw_json: string | null;
  grade_seniority: string | null; grade_market_signal: string | null; graded_at: string | null;
  fetched_at: string; last_seen_at: string; still_live: number;
}
export const getJob = (id: number): Job | undefined =>
  db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;

export function setJobGrade(jobId: number, seniority: string, signal: string,
                            skills: { skill: string; kind: string }[]): void {
  const tx = db.transaction(() => {
    db.prepare("UPDATE jobs SET grade_seniority=?, grade_market_signal=?, graded_at=datetime('now') WHERE id=?")
      .run(seniority, signal, jobId);
    db.prepare("DELETE FROM job_skills WHERE job_id=?").run(jobId);
    const ins = db.prepare("INSERT OR IGNORE INTO job_skills (job_id, skill, kind) VALUES (?, ?, ?)");
    for (const s of skills) ins.run(jobId, s.skill, s.kind);
  });
  tx();
}

export const setJobFit = (jobId: number, band: string, gaps: unknown, rationale: string): void => {
  db.prepare(
    `INSERT INTO job_fit (job_id, band, gaps_json, rationale) VALUES (?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET band=excluded.band, gaps_json=excluded.gaps_json,
       rationale=excluded.rationale`,
  ).run(jobId, band, JSON.stringify(gaps ?? null), rationale);
};

export interface JobSkill { skill: string; kind: string }
export const getJobSkills = (jobId: number): JobSkill[] =>
  db.prepare(
    "SELECT skill, kind FROM job_skills WHERE job_id = ? ORDER BY CASE kind WHEN 'required' THEN 0 ELSE 1 END, skill",
  ).all(jobId) as JobSkill[];

// ── job fetch write path (gather('fetch_jobs') calls this — db.ts is the sole writer) ──
// Idempotent per board: upsert each posting by (company_id, source_url) and refresh
// last_seen_at + still_live=1 for those present this fetch, then a LIVENESS pass closes
// (still_live=0) any of this company's still-live jobs that vanished from the feed. An
// empty feed (a valid but vacant board → []) closes them all; an UNREACHABLE board must
// NOT reach here (callers skip on null) so a transient 404 never closes a whole company.
// Reappearing jobs reopen (still_live=1). Stamps companies.last_fetched_at. Grades are
// left untouched — a refetch never wipes a job's grade, only its liveness/raw fields.
export interface RawJobInput {
  source_url: string; title?: string | null; location?: string | null;
  remote?: number | null; comp_min?: number | null; comp_max?: number | null; raw?: unknown;
}
export interface FetchJobsResult { inserted: number; updated: number; closed: number; seen: number }
export function upsertJobs(companyId: number, jobs: RawJobInput[]): FetchJobsResult {
  const tx = db.transaction((): FetchJobsResult => {
    const upsert = db.prepare(
      `INSERT INTO jobs (company_id, source_url, title, location, remote, comp_min, comp_max, raw_json, fetched_at, last_seen_at, still_live)
       VALUES (@company_id, @source_url, @title, @location, @remote, @comp_min, @comp_max, @raw_json, datetime('now'), datetime('now'), 1)
       ON CONFLICT(company_id, source_url) DO UPDATE SET
         title=excluded.title, location=excluded.location, remote=excluded.remote,
         comp_min=excluded.comp_min, comp_max=excluded.comp_max, raw_json=excluded.raw_json,
         last_seen_at=datetime('now'), still_live=1`);
    const exists = db.prepare("SELECT 1 FROM jobs WHERE company_id=? AND source_url=?");
    const seen: string[] = [];
    let inserted = 0, updated = 0;
    for (const j of jobs) {
      if (!j.source_url) continue;
      const had = exists.get(companyId, j.source_url);
      upsert.run({
        company_id: companyId, source_url: j.source_url, title: j.title ?? null, location: j.location ?? null,
        remote: j.remote ?? null, comp_min: j.comp_min ?? null, comp_max: j.comp_max ?? null,
        raw_json: j.raw != null ? JSON.stringify(j.raw) : null,
      });
      had ? updated++ : inserted++;
      seen.push(j.source_url);
    }
    const closed = seen.length === 0
      ? db.prepare("UPDATE jobs SET still_live=0 WHERE company_id=? AND still_live=1").run(companyId).changes
      : db.prepare(`UPDATE jobs SET still_live=0 WHERE company_id=? AND still_live=1 AND source_url NOT IN (${seen.map(() => "?").join(",")})`).run(companyId, ...seen).changes;
    db.prepare("UPDATE companies SET last_fetched_at=datetime('now') WHERE id=?").run(companyId);
    return { inserted, updated, closed, seen: seen.length };
  });
  return tx();
}

export interface Company {
  id: number; name: string; domain: string | null; tags: string | null; source: string | null;
  ats_platform: string | null; ats_slug: string | null; resolved: number;
  resolve_attempts: number; last_resolve_attempt_at: string | null;
  added_at: string; last_fetched_at: string | null;
}
const COMPANY_COLS = "id, name, domain, tags, source, ats_platform, ats_slug, resolved, resolve_attempts, last_resolve_attempt_at, added_at, last_fetched_at";
export const getCompanies = (limit = 200): Company[] =>
  db.prepare(`SELECT ${COMPANY_COLS} FROM companies ORDER BY added_at DESC LIMIT ?`).all(limit) as Company[];

// Look up a company by its resolved ATS slug — fetch_jobs uses this to attach pulled jobs.
export const getCompanyByAts = (platform: string, slug: string): Company | undefined =>
  db.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE ats_platform=? AND ats_slug=?`).get(platform, slug) as Company | undefined;

// Resolved (slug-complete) companies, stalest-first (never-fetched NULLs sort first in
// SQLite ASC) — the batch fetch_jobs refresh order.
export const getResolvedCompanies = (limit = 200): Company[] =>
  db.prepare(
    `SELECT ${COMPANY_COLS} FROM companies WHERE resolved=1 AND ats_platform IS NOT NULL AND ats_slug IS NOT NULL ORDER BY last_fetched_at ASC, added_at ASC LIMIT ?`,
  ).all(limit) as Company[];

// ── company write path (build-zero: the persisters gather('find_companies') will call) ──
// Naming reconciliation with tool1_build.md: the doc's "Tool A" is db.ts (this file — the
// only writer); its add_resolved_company / add_unresolved_candidate both map to upsertCompany
// (slug-complete → resolved=1; domain-only → resolved=0); its markCompanyResolved is
// resolveCompany. There is no separate unresolved_candidates table — an unresolved candidate
// is just a companies row with resolved=0, per the repo's existing schema.
//
// Dedup is accessor-level (matching the upsertProfile precedent of putting logic in the
// accessor): match on the (ats_platform, ats_slug) tuple first, then on normalized domain,
// coalescing fields on a hit so a later pass can fill blanks without clobbering known data.

const normalizeDomain = (d?: string | null): string | null => {
  if (!d) return null;
  const s = d.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
  return s || null;
};

// tags is a plain TEXT column (no _json suffix — the repo reserves that for JSON blobs),
// so tags serialize as a comma-delimited, de-duplicated, sorted string of namespaced values.
const parseTags = (s: string | null | undefined): string[] =>
  s ? s.split(",").map((t) => t.trim()).filter(Boolean) : [];
const serializeTags = (tags: string[]): string | null => {
  const u = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
  return u.length ? u.join(",") : null;
};

export interface CompanyInput {
  name: string;
  domain?: string | null;
  source?: string | null;          // provenance, e.g. 'theirstack' | 'common_crawl'
  tags?: string[];                 // namespaced, e.g. ['funding:series_b', 'size:51-200']
  ats_platform?: string | null;    // 'ashby' | 'greenhouse' | 'lever' | 'workable'
  ats_slug?: string | null;
  resolved?: boolean;              // explicit override; defaults to (ats_platform && ats_slug)
}
export interface UpsertResult { id: number; inserted: boolean }
export interface ResolveResult { id: number; merged: boolean }

const findBySlug = (platform: string, slug: string): Company | undefined =>
  db.prepare("SELECT * FROM companies WHERE ats_platform = ? AND ats_slug = ?").get(platform, slug) as Company | undefined;
const findByDomain = (domain: string): Company | undefined =>
  db.prepare("SELECT * FROM companies WHERE domain = ? ORDER BY id LIMIT 1").get(domain) as Company | undefined;

/**
 * Idempotent insert-or-merge for a discovered company. Matches an existing row by the
 * (ats_platform, ats_slug) tuple, then by normalized domain; on a hit it fills missing
 * fields and unions tags, never overwriting known data. Slug-complete input is stored
 * resolved=1, domain-only input resolved=0. Returns the row id and whether it was a fresh
 * insert — so a discovery run can count net-new (credit accounting, dedup-before-fetch).
 */
export function upsertCompany(input: CompanyInput): UpsertResult {
  const platform = input.ats_platform ?? null;
  const slug = input.ats_slug ?? null;
  const domain = normalizeDomain(input.domain);
  const resolved = input.resolved ?? !!(platform && slug);

  // Gather every existing row this input keys into — by slug-tuple and/or by domain. When the
  // two keys hit two *different* rows, the same company was discovered two ways with no
  // overlapping key until now; unify them (fold the extras into one) so no duplicate lingers.
  const bySlug = platform && slug ? findBySlug(platform, slug) : undefined;
  const byDomain = domain ? findByDomain(domain) : undefined;
  const matches: Company[] = [];
  if (bySlug) matches.push(bySlug);
  if (byDomain && !matches.some((m) => m.id === byDomain.id)) matches.push(byDomain);

  if (matches.length === 0) {
    const info = db.prepare(
      `INSERT INTO companies (name, domain, tags, source, ats_platform, ats_slug, resolved)
       VALUES (@name, @domain, @tags, @source, @ats_platform, @ats_slug, @resolved)`,
    ).run({
      name: input.name, domain, tags: serializeTags(input.tags ?? []),
      source: input.source ?? null, ats_platform: platform, ats_slug: slug, resolved: resolved ? 1 : 0,
    });
    return { id: Number(info.lastInsertRowid), inserted: true };
  }

  const primary = matches[0];
  // Fold any additional matched rows into the primary, deleting each first so its slug-tuple
  // is free before we COALESCE the tuple onto the primary (avoids hitting UNIQUE).
  for (const m of matches.slice(1)) {
    const folded = { domain: m.domain, source: m.source, tags: parseTags(m.tags),
                     ats_platform: m.ats_platform, ats_slug: m.ats_slug, resolved: m.resolved === 1 };
    db.prepare("DELETE FROM companies WHERE id = ?").run(m.id);
    mergeFields(primary.id, folded);
  }
  mergeFields(primary.id, { domain, source: input.source, tags: input.tags, ats_platform: platform, ats_slug: slug, resolved });
  return { id: primary.id, inserted: false };
}

// Fill missing columns and union tags onto an existing row (by id, re-read fresh so a prior
// fold in the same call isn't lost) — never overwrites a known value. Callers guarantee any
// slug-tuple passed here is free (not owned by another row).
function mergeFields(
  id: number,
  input: { domain?: string | null; source?: string | null; tags?: string[]; ats_platform?: string | null; ats_slug?: string | null; resolved?: boolean },
): void {
  const row = db.prepare("SELECT tags, ats_platform, ats_slug, resolved FROM companies WHERE id = ?")
    .get(id) as { tags: string | null; ats_platform: string | null; ats_slug: string | null; resolved: number } | undefined;
  if (!row) return;
  const tags = serializeTags([...parseTags(row.tags), ...(input.tags ?? [])]);
  const platform = row.ats_platform ?? input.ats_platform ?? null;
  const slug = row.ats_slug ?? input.ats_slug ?? null;
  const resolved = row.resolved === 1 || input.resolved === true || (!!platform && !!slug) ? 1 : 0;
  db.prepare(
    `UPDATE companies SET
       domain       = COALESCE(domain, @domain),
       tags         = @tags,
       source       = COALESCE(source, @source),
       ats_platform = COALESCE(ats_platform, @ats_platform),
       ats_slug     = COALESCE(ats_slug, @ats_slug),
       resolved     = @resolved
     WHERE id = @id`,
  ).run({
    id,
    domain: normalizeDomain(input.domain),
    tags,
    source: input.source ?? null,
    ats_platform: input.ats_platform ?? null,
    ats_slug: input.ats_slug ?? null,
    resolved,
  });
}

/**
 * Stage-4 success: an unresolved candidate's ATS board was found. Sets the slug-tuple and
 * flips resolved=1. Collision-safe — if another row already owns this (platform, slug), the
 * candidate is folded into that owner (domain/tags copied across) and removed, returning the
 * surviving id (merged=true).
 */
export function resolveCompany(id: number, platform: string, slug: string): ResolveResult {
  const owner = findBySlug(platform, slug);
  if (owner && owner.id !== id) {
    const cand = db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Company | undefined;
    if (cand) {
      mergeFields(owner.id, { domain: cand.domain, source: cand.source, tags: parseTags(cand.tags), resolved: true });
      db.prepare("DELETE FROM companies WHERE id = ?").run(id);
    }
    return { id: owner.id, merged: true };
  }
  db.prepare("UPDATE companies SET ats_platform = ?, ats_slug = ?, resolved = 1 WHERE id = ?").run(platform, slug, id);
  return { id, merged: false };
}

/** Stage-4 failure: record an attempt so a run can skip/deprioritise repeat failures. */
export const bumpResolveAttempt = (id: number): void => {
  db.prepare(
    "UPDATE companies SET resolve_attempts = resolve_attempts + 1, last_resolve_attempt_at = datetime('now') WHERE id = ?",
  ).run(id);
};

const countOf = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { c: number }).c;
export interface Counts { companies: number; unresolved: number; jobs: number; ungraded: number; portfolio: number }
export const counts = (): Counts => ({
  companies: countOf("SELECT count(*) c FROM companies"),
  unresolved: countOf("SELECT count(*) c FROM companies WHERE resolved = 0"),
  jobs: countOf("SELECT count(*) c FROM jobs"),
  ungraded: countOf("SELECT count(*) c FROM jobs WHERE grade_seniority IS NULL"),
  portfolio: countOf("SELECT count(*) c FROM portfolio_projects"),
});
