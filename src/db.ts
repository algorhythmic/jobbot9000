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
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  domain          TEXT,
  tags            TEXT,
  source          TEXT,
  ats_platform    TEXT,
  ats_slug        TEXT,
  resolved        INTEGER NOT NULL DEFAULT 1,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT,
  UNIQUE (ats_platform, ats_slug)
);
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

export interface Company {
  id: number; name: string; domain: string | null; tags: string | null; source: string | null;
  ats_platform: string | null; ats_slug: string | null; resolved: number; added_at: string; last_fetched_at: string | null;
}
export const getCompanies = (limit = 200): Company[] =>
  db.prepare(
    "SELECT id, name, domain, tags, source, ats_platform, ats_slug, resolved, added_at, last_fetched_at FROM companies ORDER BY added_at DESC LIMIT ?",
  ).all(limit) as Company[];

const countOf = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { c: number }).c;
export interface Counts { companies: number; jobs: number; ungraded: number; portfolio: number }
export const counts = (): Counts => ({
  companies: countOf("SELECT count(*) c FROM companies"),
  jobs: countOf("SELECT count(*) c FROM jobs"),
  ungraded: countOf("SELECT count(*) c FROM jobs WHERE grade_seniority IS NULL"),
  portfolio: countOf("SELECT count(*) c FROM portfolio_projects"),
});
