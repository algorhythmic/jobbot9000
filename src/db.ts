// db.ts — the SQLite layer and the ONLY code that writes the database.
// Two planes: `personal` (local always, never shared) and `catalog` (public market
// data). Tools call these helpers; the agent never issues a raw write. v2: the model is
// the readiness LOOP (profile⇅desires → match → interview → upskill → apply → re-match),
// state is multi-dimensional and DURABLE — versioned history + an append-only journal so a
// search that spans months never loses progress and any new session resumes from the DB.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// STATE_DIR is set by the plugin to ${CLAUDE_PLUGIN_DATA}/state — a persistent, per-plugin
// directory (~/.claude/plugins/data/<id>/) that survives sessions AND plugin updates. If the
// host didn't expand that variable (unset, or a literal "${...}"), fall back to a STABLE
// absolute path under the home dir, NEVER a cwd-relative one (which would fragment the DB).
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

// The competency/seniority ladder — the single canonical order, mirrored by the grading
// modes (modes/*.json). Index = rank. Kept here too because db derives the overall band.
export const LADDER = ["intern", "junior", "mid", "senior", "staff", "principal"] as const;
const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;
// The four competency dimensions (Leaner-4). The profile carries one row per dimension.
export const DIMENSIONS = ["technical_depth", "system_design", "communication", "ownership"] as const;

db.exec(`
-- ── personal plane — local always; never shared ──────────────────────────
CREATE TABLE IF NOT EXISTS profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  target_role   TEXT,
  target_niche  TEXT,
  location_pref TEXT,
  github_handle TEXT,
  desires_json  TEXT,                                 -- {role_types, domains, locations, comp_floor, work_style, freetext, priorities} — evolvable
  no_resume     INTEGER NOT NULL DEFAULT 0,
  no_github     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS master_resume (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS resume_revisions (          -- append-only history: how the resume evolved
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  rationale  TEXT,                                     -- why this revision (the coaching applied)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS portfolio_projects (
  repo       TEXT PRIMARY KEY,                         -- github: "owner/name"; manual: a bare name (no slash)
  facts_json TEXT,
  source     TEXT NOT NULL DEFAULT 'github',           -- 'github' (ingested) | 'manual' (described, unverified)
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS portfolio_relevance (       -- a project's relevance to the target role (judgment)
  repo              TEXT PRIMARY KEY,
  relevance         TEXT NOT NULL,                      -- strong | moderate | weak
  demonstrates_json TEXT,
  gaps_json         TEXT,
  rationale         TEXT,
  graded_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The multi-dimensional competency profile (replaces the single-ladder assessment). One row
-- per dimension; the overall band is DERIVED (deriveBand). Absence of evidence → low
-- CONFIDENCE, never a low level (fair to candidates with no public portfolio).
CREATE TABLE IF NOT EXISTS competency_profile (
  dimension     TEXT PRIMARY KEY,                       -- one of DIMENSIONS
  level         TEXT NOT NULL,                          -- one of LADDER
  confidence    TEXT NOT NULL,                          -- low | medium | high (high needs demonstrated/corroborated)
  evidence_json TEXT,                                   -- [{ claim, provenance, verified }]
  rationale     TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assessment_summary (        -- cached derived overall band/confidence/floor + verified flag
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  band       TEXT,
  confidence TEXT,
  floor      TEXT,
  verified   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fitness_snapshots (          -- append-only: band + per-dim levels over time → improvement
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  band      TEXT,
  confidence TEXT,
  dims_json TEXT,                                        -- { dimension: level }
  taken_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS interviews (                 -- a competency or role-fit interview SESSION (resumable)
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT NOT NULL,                        -- competency | role_fit
  job_id           INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | complete
  verified_ceiling TEXT,                                 -- highest level the interview supports (caps an over-claim)
  summary          TEXT,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS interview_items (            -- per-question: answer + grounded exemplar + the delta
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id  INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  dimension     TEXT,                                    -- which competency (or null)
  claim         TEXT,                                    -- claim probed (or null)
  question      TEXT NOT NULL,
  answer_summary TEXT,
  exemplar      TEXT,                                    -- role+rubric-grounded "what a great candidate would say"
  score         TEXT,                                    -- weak | adequate | strong
  ownership     TEXT,                                    -- sole_author | contributor | user | observer
  understanding TEXT,                                    -- deep | working | shallow | cannot_explain
  delta_notes   TEXT,                                    -- the gap → upskilling target
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS upskilling_plan (            -- the tracked plan: learn / resume / build
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  gap            TEXT NOT NULL,                           -- dimension or skill being closed
  type           TEXT NOT NULL,                           -- learn | resume | build
  spec           TEXT NOT NULL,                           -- the concrete recommendation
  market_demand  TEXT,                                    -- which in-demand skill it closes (grounding)
  status         TEXT NOT NULL DEFAULT 'suggested',       -- suggested | in_progress | done
  progress_notes TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS role_fit (                   -- the user's fit on a job (judgment, personal)
  job_id           INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  band             TEXT NOT NULL,                         -- over | exact | under
  dim_deltas_json  TEXT,                                  -- per-dimension gap vs the role
  desire_alignment TEXT,                                  -- strong | mixed | weak (vs the user's desires)
  gaps_json        TEXT,
  rationale        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cover_letters (              -- the per-role deliverable
  job_id              INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  talking_points_json TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS applications (               -- the user's application to a job (personal)
  job_id         INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,                           -- interested | applied | interviewing | offer | rejected | withdrawn
  applied_at     TEXT,
  next_action    TEXT,
  next_action_at TEXT,
  notes          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (                     -- APPEND-ONLY journal — the narrative timeline; never mutated/pruned
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  kind    TEXT NOT NULL,                                  -- assessed | interviewed | graded_job | role_fit | planned | plan_progress | resume_revised | applied | profile | matched
  summary TEXT NOT NULL,
  ref     TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── catalog plane — public market data (no longer synced) ─────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL,
  domain                  TEXT,
  tags                    TEXT,
  source                  TEXT,
  ats_platform            TEXT,
  ats_slug                TEXT,
  resolved                INTEGER NOT NULL DEFAULT 1,
  resolve_attempts        INTEGER NOT NULL DEFAULT 0,
  last_resolve_attempt_at TEXT,
  added_at                TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at         TEXT,
  UNIQUE (ats_platform, ats_slug)
);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE TABLE IF NOT EXISTS jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_url          TEXT NOT NULL,
  title               TEXT,
  location            TEXT,
  remote              INTEGER,
  comp_min            REAL,
  comp_max            REAL,
  raw_json            TEXT,
  grade_seniority     TEXT,
  grade_market_signal TEXT,
  graded_at           TEXT,
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  still_live          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, source_url)
);
CREATE TABLE IF NOT EXISTS job_skills (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill  TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('required','preferred')),
  UNIQUE (job_id, skill, kind)
);
`);

// ── guarded migrations — additive columns for DBs created before they existed. No-ops on a
// fresh DB. ALTER ADD COLUMN is the only safe in-place change.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("companies", "resolve_attempts", "resolve_attempts INTEGER NOT NULL DEFAULT 0");
ensureColumn("companies", "last_resolve_attempt_at", "last_resolve_attempt_at TEXT");
ensureColumn("portfolio_projects", "source", "source TEXT NOT NULL DEFAULT 'github'");
ensureColumn("profile", "desires_json", "desires_json TEXT");

// ── the journal (durability) ────────────────────────────────────────────────
// Every meaningful step appends here so the months-long journey is always reconstructable.
// Judgment writes call this internally; it's also the timeline look(at:'history') reads.
export interface EventRow { id: number; ts: string; kind: string; summary: string; ref: string | null }
export const logEvent = (kind: string, summary: string, ref?: string | null): void => {
  db.prepare("INSERT INTO events (kind, summary, ref) VALUES (?, ?, ?)").run(kind, summary, ref ?? null);
};
export const getEvents = (limit = 50): EventRow[] =>
  db.prepare("SELECT id, ts, kind, summary, ref FROM events ORDER BY id DESC LIMIT ?").all(limit) as EventRow[];

// ── personal accessors ─────────────────────────────────────────────────────
export interface Desires {
  role_types?: string[]; domains?: string[]; locations?: string[];
  comp_floor?: number | null; work_style?: string | null; freetext?: string | null; priorities?: string[];
}
export interface Profile {
  target_role: string | null; target_niche: string | null; location_pref: string | null;
  github_handle: string | null; desires: Desires | null; no_resume: number; no_github: number;
}
export const getProfile = (): Profile | undefined => {
  const r = db.prepare("SELECT target_role, target_niche, location_pref, github_handle, desires_json, no_resume, no_github FROM profile WHERE id = 1")
    .get() as (Omit<Profile, "desires"> & { desires_json: string | null }) | undefined;
  if (!r) return undefined;
  const { desires_json, ...rest } = r;
  return { ...rest, desires: desires_json ? JSON.parse(desires_json) : null };
};

export function upsertProfile(p: Partial<Omit<Profile, "desires">> & { desires?: Desires | null }): void {
  const cur = getProfile();
  const desires = p.desires !== undefined
    ? (p.desires ? { ...(cur?.desires ?? {}), ...p.desires } : null) // merge desires, don't clobber
    : (cur?.desires ?? null);
  const m = {
    target_role: p.target_role !== undefined ? p.target_role : cur?.target_role ?? null,
    target_niche: p.target_niche !== undefined ? p.target_niche : cur?.target_niche ?? null,
    location_pref: p.location_pref !== undefined ? p.location_pref : cur?.location_pref ?? null,
    github_handle: p.github_handle !== undefined ? p.github_handle : cur?.github_handle ?? null,
    no_resume: p.no_resume !== undefined ? p.no_resume : cur?.no_resume ?? 0,
    no_github: p.no_github !== undefined ? p.no_github : cur?.no_github ?? 0,
    desires_json: desires ? JSON.stringify(desires) : null,
  };
  db.prepare(
    `INSERT INTO profile (id, target_role, target_niche, location_pref, github_handle, desires_json, no_resume, no_github, updated_at)
     VALUES (1, @target_role, @target_niche, @location_pref, @github_handle, @desires_json, @no_resume, @no_github, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       target_role=excluded.target_role, target_niche=excluded.target_niche,
       location_pref=excluded.location_pref, github_handle=excluded.github_handle,
       desires_json=excluded.desires_json, no_resume=excluded.no_resume, no_github=excluded.no_github,
       updated_at=datetime('now')`,
  ).run(m);
}

export const getMasterResume = (): { content: string; updated_at: string } | undefined =>
  db.prepare("SELECT content, updated_at FROM master_resume WHERE id = 1").get() as { content: string; updated_at: string } | undefined;
// Set the master resume and, when a rationale is given (a coached revision rather than the
// initial capture), append it to the version history so resume-building is tracked over time.
export const setMasterResume = (content: string, rationale?: string | null): void => {
  db.prepare(
    `INSERT INTO master_resume (id, content, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`,
  ).run(content);
  if (rationale !== undefined) {
    db.prepare("INSERT INTO resume_revisions (content, rationale) VALUES (?, ?)").run(content, rationale ?? null);
    logEvent("resume_revised", rationale ?? "resume revised");
  }
};
export interface ResumeRevision { id: number; rationale: string | null; created_at: string }
export const getResumeRevisions = (): ResumeRevision[] =>
  db.prepare("SELECT id, rationale, created_at FROM resume_revisions ORDER BY id DESC").all() as ResumeRevision[];

// ── portfolio ────────────────────────────────────────────────────────────────
export interface PortfolioProject { repo: string; facts_json: string | null; source: string; fetched_at: string }
export const getPortfolio = (): PortfolioProject[] =>
  db.prepare("SELECT repo, facts_json, source, fetched_at FROM portfolio_projects ORDER BY fetched_at DESC, repo").all() as PortfolioProject[];

export function replacePortfolio(projects: { repo: string; facts: unknown }[]): number {
  const tx = db.transaction((): number => {
    db.prepare("DELETE FROM portfolio_projects WHERE source='github'").run();
    const ins = db.prepare("INSERT INTO portfolio_projects (repo, facts_json, source) VALUES (?, ?, 'github')");
    for (const p of projects) ins.run(p.repo, JSON.stringify(p.facts ?? null));
    const keep = [...projects.map((p) => p.repo), ...(db.prepare("SELECT repo FROM portfolio_projects WHERE source='manual'").all() as { repo: string }[]).map((r) => r.repo)];
    if (keep.length === 0) db.prepare("DELETE FROM portfolio_relevance").run();
    else db.prepare(`DELETE FROM portfolio_relevance WHERE repo NOT IN (${keep.map(() => "?").join(",")})`).run(...keep);
    return projects.length;
  });
  return tx();
}

export function addPortfolioProject(name: string, facts: unknown): void {
  db.prepare(
    `INSERT INTO portfolio_projects (repo, facts_json, source, fetched_at) VALUES (?, ?, 'manual', datetime('now'))
     ON CONFLICT(repo) DO UPDATE SET facts_json=excluded.facts_json, source='manual', fetched_at=datetime('now')`,
  ).run(name, JSON.stringify(facts ?? null));
}

export interface PortfolioRelevance {
  repo: string; relevance: string; demonstrates: unknown[]; gaps: unknown[]; rationale: string | null; graded_at: string;
}
export const getPortfolioRelevance = (repo: string): PortfolioRelevance | undefined => {
  const r = db.prepare("SELECT repo, relevance, demonstrates_json, gaps_json, rationale, graded_at FROM portfolio_relevance WHERE repo = ?")
    .get(repo) as { repo: string; relevance: string; demonstrates_json: string | null; gaps_json: string | null; rationale: string | null; graded_at: string } | undefined;
  return r ? { repo: r.repo, relevance: r.relevance, demonstrates: r.demonstrates_json ? JSON.parse(r.demonstrates_json) : [], gaps: r.gaps_json ? JSON.parse(r.gaps_json) : [], rationale: r.rationale, graded_at: r.graded_at } : undefined;
};
export const setPortfolioRelevance = (repo: string, relevance: string, demonstrates: unknown, gaps: unknown, rationale: string): void => {
  db.prepare(
    `INSERT INTO portfolio_relevance (repo, relevance, demonstrates_json, gaps_json, rationale, graded_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(repo) DO UPDATE SET relevance=excluded.relevance, demonstrates_json=excluded.demonstrates_json,
       gaps_json=excluded.gaps_json, rationale=excluded.rationale, graded_at=datetime('now')`,
  ).run(repo, relevance, JSON.stringify(demonstrates ?? []), JSON.stringify(gaps ?? []), rationale);
};

// ── competency profile + derived band (the assessment, multi-dimensional) ────
export interface Competency { dimension: string; level: string; confidence: string; evidence: unknown; rationale: string | null; updated_at: string }
export const getCompetencyProfile = (): Competency[] =>
  (db.prepare("SELECT dimension, level, confidence, evidence_json, rationale, updated_at FROM competency_profile").all() as
    { dimension: string; level: string; confidence: string; evidence_json: string | null; rationale: string | null; updated_at: string }[])
    .map((r) => ({ dimension: r.dimension, level: r.level, confidence: r.confidence, evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [], rationale: r.rationale, updated_at: r.updated_at }));

// Set one dimension's judgment, refresh the cached summary, and snapshot fitness so the
// trajectory is preserved. Appends a journal event.
export function setCompetency(dimension: string, level: string, confidence: string, evidence: unknown, rationale: string): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO competency_profile (dimension, level, confidence, evidence_json, rationale, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(dimension) DO UPDATE SET level=excluded.level, confidence=excluded.confidence,
         evidence_json=excluded.evidence_json, rationale=excluded.rationale, updated_at=datetime('now')`,
    ).run(dimension, level, confidence, JSON.stringify(evidence ?? []), rationale);
    refreshAssessmentSummary();
    snapshotFitness();
    logEvent("assessed", `${dimension} → ${level} (confidence ${confidence})`, dimension);
  });
  tx();
}

// Derive the overall band from the dimensions: band = conservative (floor of the mean rank),
// floor = the lowest dimension, overall confidence = the LOWEST (skeptical — a profile is only
// as trustworthy as its weakest-supported part). null until at least one dimension is set.
export interface DerivedBand { band: string; floor: string; confidence: string; dims: number }
export function deriveBand(profile: Competency[] = getCompetencyProfile()): DerivedBand | null {
  if (profile.length === 0) return null;
  const idxs = profile.map((d) => LADDER.indexOf(d.level as typeof LADDER[number])).filter((i) => i >= 0);
  if (idxs.length === 0) return null;
  const band = LADDER[Math.floor(idxs.reduce((a, b) => a + b, 0) / idxs.length)];
  const floor = LADDER[Math.min(...idxs)];
  const confIdx = Math.min(...profile.map((d) => Math.max(0, CONFIDENCE_ORDER.indexOf(d.confidence as typeof CONFIDENCE_ORDER[number]))));
  return { band, floor, confidence: CONFIDENCE_ORDER[confIdx], dims: profile.length };
}

export interface AssessmentSummary { band: string | null; confidence: string | null; floor: string | null; verified: number; updated_at: string | null }
export const getAssessmentSummary = (): AssessmentSummary | undefined =>
  db.prepare("SELECT band, confidence, floor, verified, updated_at FROM assessment_summary WHERE id = 1").get() as AssessmentSummary | undefined;
// Recompute the cached summary from the dimensions + interview state. `verified` is true once
// at least one interview is complete (that's what earns the profile beyond self-report).
function refreshAssessmentSummary(): void {
  const d = deriveBand();
  const verified = (db.prepare("SELECT count(*) c FROM interviews WHERE status='complete'").get() as { c: number }).c > 0 ? 1 : 0;
  db.prepare(
    `INSERT INTO assessment_summary (id, band, confidence, floor, verified, updated_at)
     VALUES (1, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET band=excluded.band, confidence=excluded.confidence, floor=excluded.floor,
       verified=excluded.verified, updated_at=datetime('now')`,
  ).run(d?.band ?? null, d?.confidence ?? null, d?.floor ?? null, verified);
}

export interface FitnessSnapshot { id: number; band: string | null; confidence: string | null; dims: Record<string, string>; taken_at: string }
function snapshotFitness(): void {
  const d = deriveBand();
  const dims = Object.fromEntries(getCompetencyProfile().map((c) => [c.dimension, c.level]));
  db.prepare("INSERT INTO fitness_snapshots (band, confidence, dims_json) VALUES (?, ?, ?)").run(d?.band ?? null, d?.confidence ?? null, JSON.stringify(dims));
}
export const getFitnessHistory = (limit = 50): FitnessSnapshot[] =>
  (db.prepare("SELECT id, band, confidence, dims_json, taken_at FROM fitness_snapshots ORDER BY id DESC LIMIT ?").all(limit) as
    { id: number; band: string | null; confidence: string | null; dims_json: string | null; taken_at: string }[])
    .map((r) => ({ id: r.id, band: r.band, confidence: r.confidence, dims: r.dims_json ? JSON.parse(r.dims_json) : {}, taken_at: r.taken_at }));

// ── interviews (resumable; the assess + verify + upskill engine) ─────────────
export interface Interview { id: number; type: string; job_id: number | null; status: string; verified_ceiling: string | null; summary: string | null; started_at: string; updated_at: string }
export const getInterview = (id: number): Interview | undefined =>
  db.prepare("SELECT * FROM interviews WHERE id = ?").get(id) as Interview | undefined;
export const getOpenInterview = (): Interview | undefined =>
  db.prepare("SELECT * FROM interviews WHERE status='in_progress' ORDER BY id DESC LIMIT 1").get() as Interview | undefined;
export const getInterviews = (): Interview[] =>
  db.prepare("SELECT * FROM interviews ORDER BY id DESC").all() as Interview[];
export function startInterview(type: string, jobId?: number | null): number {
  const info = db.prepare("INSERT INTO interviews (type, job_id) VALUES (?, ?)").run(type, jobId ?? null);
  logEvent("interviewed", `started ${type} interview${jobId ? ` for job ${jobId}` : ""}`, String(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}
export interface InterviewItemInput { dimension?: string | null; claim?: string | null; question: string; answer_summary?: string | null; exemplar?: string | null; score?: string | null; ownership?: string | null; understanding?: string | null; delta_notes?: string | null }
export function addInterviewItems(interviewId: number, items: InterviewItemInput[]): void {
  const tx = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO interview_items (interview_id, dimension, claim, question, answer_summary, exemplar, score, ownership, understanding, delta_notes)
       VALUES (@interview_id, @dimension, @claim, @question, @answer_summary, @exemplar, @score, @ownership, @understanding, @delta_notes)`);
    for (const it of items) ins.run({
      interview_id: interviewId, dimension: it.dimension ?? null, claim: it.claim ?? null, question: it.question,
      answer_summary: it.answer_summary ?? null, exemplar: it.exemplar ?? null, score: it.score ?? null,
      ownership: it.ownership ?? null, understanding: it.understanding ?? null, delta_notes: it.delta_notes ?? null,
    });
    db.prepare("UPDATE interviews SET updated_at=datetime('now') WHERE id=?").run(interviewId);
  });
  tx();
}
export interface InterviewItem extends InterviewItemInput { id: number; interview_id: number; created_at: string }
export const getInterviewItems = (interviewId: number): InterviewItem[] =>
  db.prepare("SELECT * FROM interview_items WHERE interview_id = ? ORDER BY id").all(interviewId) as InterviewItem[];
export function completeInterview(interviewId: number, verifiedCeiling: string | null, summary: string): void {
  db.prepare("UPDATE interviews SET status='complete', verified_ceiling=?, summary=?, updated_at=datetime('now') WHERE id=?")
    .run(verifiedCeiling, summary, interviewId);
  refreshAssessmentSummary(); // completing an interview flips `verified`
  logEvent("interviewed", `completed interview ${interviewId}${verifiedCeiling ? ` (verified_ceiling ${verifiedCeiling})` : ""}`, String(interviewId));
}

// ── upskilling plan (learn / resume / build — tracked, drives re-match) ──────
export interface PlanItem { id: number; gap: string; type: string; spec: string; market_demand: string | null; status: string; progress_notes: string | null; created_at: string; updated_at: string }
export const getPlan = (status?: string): PlanItem[] =>
  status
    ? db.prepare("SELECT * FROM upskilling_plan WHERE status = ? ORDER BY id").all(status) as PlanItem[]
    : db.prepare("SELECT * FROM upskilling_plan ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, id").all() as PlanItem[];
export function addPlanItem(gap: string, type: string, spec: string, marketDemand?: string | null): number {
  const info = db.prepare("INSERT INTO upskilling_plan (gap, type, spec, market_demand) VALUES (?, ?, ?, ?)").run(gap, type, spec, marketDemand ?? null);
  logEvent("planned", `${type} · ${gap}: ${spec}`, String(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}
export function updatePlanItem(id: number, status?: string | null, progressNotes?: string | null): boolean {
  const cur = db.prepare("SELECT id, gap, type FROM upskilling_plan WHERE id = ?").get(id) as { id: number; gap: string; type: string } | undefined;
  if (!cur) return false;
  db.prepare(
    `UPDATE upskilling_plan SET status = COALESCE(?, status), progress_notes = COALESCE(?, progress_notes), updated_at = datetime('now') WHERE id = ?`,
  ).run(status ?? null, progressNotes ?? null, id);
  if (status) logEvent("plan_progress", `${cur.type} · ${cur.gap} → ${status}`, String(id));
  return true;
}
export const planCounts = (): Record<string, number> =>
  Object.fromEntries((db.prepare("SELECT status, count(*) c FROM upskilling_plan GROUP BY status").all() as { status: string; c: number }[]).map((r) => [r.status, r.c]));

// ── role fit (the user's fit on a specific job) ──────────────────────────────
export interface RoleFit { band: string; dim_deltas: unknown; desire_alignment: string | null; gaps: unknown[]; rationale: string | null }
export const getRoleFit = (jobId: number): RoleFit | undefined => {
  const r = db.prepare("SELECT band, dim_deltas_json, desire_alignment, gaps_json, rationale FROM role_fit WHERE job_id = ?")
    .get(jobId) as { band: string; dim_deltas_json: string | null; desire_alignment: string | null; gaps_json: string | null; rationale: string | null } | undefined;
  return r ? { band: r.band, dim_deltas: r.dim_deltas_json ? JSON.parse(r.dim_deltas_json) : null, desire_alignment: r.desire_alignment, gaps: r.gaps_json ? JSON.parse(r.gaps_json) : [], rationale: r.rationale } : undefined;
};
export function setRoleFit(jobId: number, band: string, dimDeltas: unknown, desireAlignment: string | null, gaps: unknown, rationale: string): void {
  db.prepare(
    `INSERT INTO role_fit (job_id, band, dim_deltas_json, desire_alignment, gaps_json, rationale)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET band=excluded.band, dim_deltas_json=excluded.dim_deltas_json,
       desire_alignment=excluded.desire_alignment, gaps_json=excluded.gaps_json, rationale=excluded.rationale`,
  ).run(jobId, band, JSON.stringify(dimDeltas ?? null), desireAlignment, JSON.stringify(gaps ?? []), rationale);
  logEvent("role_fit", `job ${jobId} → ${band}${desireAlignment ? ` (desire ${desireAlignment})` : ""}`, String(jobId));
}

export interface CoverLetter { content: string; talking_points: unknown[]; created_at: string }
export const getCoverLetter = (jobId: number): CoverLetter | null => {
  const r = db.prepare("SELECT content, talking_points_json, created_at FROM cover_letters WHERE job_id = ?")
    .get(jobId) as { content: string; talking_points_json: string | null; created_at: string } | undefined;
  return r ? { content: r.content, talking_points: r.talking_points_json ? JSON.parse(r.talking_points_json) : [], created_at: r.created_at } : null;
};
export const recordCoverLetter = (jobId: number, content: string, points: unknown): void => {
  db.prepare(
    `INSERT INTO cover_letters (job_id, content, talking_points_json) VALUES (?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET content=excluded.content, talking_points_json=excluded.talking_points_json`,
  ).run(jobId, content, JSON.stringify(points ?? null));
};

// ── application tracking (personal) ──────────────────────────────────────────
export interface Application {
  job_id: number; status: string; applied_at: string | null;
  next_action: string | null; next_action_at: string | null; notes: string | null; updated_at: string;
}
export const getApplication = (jobId: number): Application | undefined =>
  db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId) as Application | undefined;

export function recordApplication(
  jobId: number,
  fields: { status: string; applied_at?: string | null; next_action?: string | null; next_action_at?: string | null; notes?: string | null },
): void {
  const cur = getApplication(jobId);
  const pick = <K extends keyof Application>(k: K): unknown => (fields as any)[k] !== undefined ? (fields as any)[k] : (cur?.[k] ?? null);
  db.prepare(
    `INSERT INTO applications (job_id, status, applied_at, next_action, next_action_at, notes, updated_at)
     VALUES (@job_id, @status, @applied_at, @next_action, @next_action_at, @notes, datetime('now'))
     ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, applied_at=excluded.applied_at,
       next_action=excluded.next_action, next_action_at=excluded.next_action_at, notes=excluded.notes, updated_at=datetime('now')`,
  ).run({
    job_id: jobId, status: fields.status,
    applied_at: pick("applied_at"), next_action: pick("next_action"),
    next_action_at: pick("next_action_at"), notes: pick("notes"),
  });
  logEvent("applied", `job ${jobId} → ${fields.status}`, String(jobId));
}

export interface ApplicationRow extends Application { title: string | null; company: string }
export const getApplications = (): ApplicationRow[] =>
  db.prepare(
    `SELECT a.*, j.title, c.name AS company FROM applications a
     JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
     ORDER BY a.updated_at DESC`,
  ).all() as ApplicationRow[];

export const applicationCounts = (): Record<string, number> =>
  Object.fromEntries((db.prepare("SELECT status, count(*) c FROM applications GROUP BY status").all() as { status: string; c: number }[])
    .map((r) => [r.status, r.c]));

export const getMeta = (key: string): string | null =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
export const setMeta = (key: string, value: string): void => {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
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
  logEvent("graded_job", `job ${jobId} → ${seniority}/${signal}`, String(jobId));
}

export interface JobSkill { skill: string; kind: string }
export const getJobSkills = (jobId: number): JobSkill[] =>
  db.prepare(
    "SELECT skill, kind FROM job_skills WHERE job_id = ? ORDER BY CASE kind WHEN 'required' THEN 0 ELSE 1 END, skill",
  ).all(jobId) as JobSkill[];

// Live MARKET skill demand — aggregate required/preferred skills across live, graded jobs
// (optionally narrowed to a seniority band). Grounds the upskilling plan's 'build' recs.
export interface SkillDemand { skill: string; required: number; preferred: number; total: number }
export function marketSkillDemand(band?: string[] | null, limit = 20): { total_jobs: number; skills: SkillDemand[] } {
  const where = ["j.still_live=1", "j.grade_seniority IS NOT NULL"];
  const args: string[] = [];
  if (band && band.length) { where.push(`j.grade_seniority IN (${band.map(() => "?").join(",")})`); args.push(...band); }
  const clause = where.join(" AND ");
  const total_jobs = countOf(`SELECT count(*) c FROM jobs j WHERE ${clause}`, ...args);
  const skills = db.prepare(
    `SELECT s.skill,
            SUM(CASE WHEN s.kind='required' THEN 1 ELSE 0 END) AS required,
            SUM(CASE WHEN s.kind='preferred' THEN 1 ELSE 0 END) AS preferred,
            COUNT(DISTINCT s.job_id) AS total
     FROM job_skills s JOIN jobs j ON j.id=s.job_id
     WHERE ${clause}
     GROUP BY lower(s.skill)
     ORDER BY total DESC, required DESC, s.skill LIMIT ?`,
  ).all(...args, limit) as SkillDemand[];
  return { total_jobs, skills };
}

// ── job fetch write path (gather('fetch_jobs') calls this — db.ts is the sole writer) ──
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
export const getCompanyByAts = (platform: string, slug: string): Company | undefined =>
  db.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE ats_platform=? AND ats_slug=?`).get(platform, slug) as Company | undefined;
export const getResolvedCompanies = (limit = 200): Company[] =>
  db.prepare(
    `SELECT ${COMPANY_COLS} FROM companies WHERE resolved=1 AND ats_platform IS NOT NULL AND ats_slug IS NOT NULL ORDER BY last_fetched_at ASC, added_at ASC LIMIT ?`,
  ).all(limit) as Company[];

const normalizeDomain = (d?: string | null): string | null => {
  if (!d) return null;
  const s = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return s || null;
};
const parseTags = (s: string | null | undefined): string[] =>
  s ? s.split(",").map((t) => t.trim()).filter(Boolean) : [];
const serializeTags = (tags: string[]): string | null => {
  const u = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
  return u.length ? u.join(",") : null;
};

export interface CompanyInput {
  name: string; domain?: string | null; source?: string | null; tags?: string[];
  ats_platform?: string | null; ats_slug?: string | null; resolved?: boolean;
}
export interface UpsertResult { id: number; inserted: boolean }
export interface ResolveResult { id: number; merged: boolean }

const findBySlug = (platform: string, slug: string): Company | undefined =>
  db.prepare("SELECT * FROM companies WHERE ats_platform = ? AND ats_slug = ?").get(platform, slug) as Company | undefined;
const findByDomain = (domain: string): Company | undefined =>
  db.prepare("SELECT * FROM companies WHERE domain = ? ORDER BY id LIMIT 1").get(domain) as Company | undefined;

export function upsertCompany(input: CompanyInput): UpsertResult {
  const platform = input.ats_platform ?? null;
  const slug = input.ats_slug ?? null;
  const domain = normalizeDomain(input.domain);
  const resolved = input.resolved ?? !!(platform && slug);

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
  for (const m of matches.slice(1)) {
    const folded = { domain: m.domain, source: m.source, tags: parseTags(m.tags),
                     ats_platform: m.ats_platform, ats_slug: m.ats_slug, resolved: m.resolved === 1 };
    db.prepare("DELETE FROM companies WHERE id = ?").run(m.id);
    mergeFields(primary.id, folded);
  }
  mergeFields(primary.id, { domain, source: input.source, tags: input.tags, ats_platform: platform, ats_slug: slug, resolved });
  return { id: primary.id, inserted: false };
}

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
    id, domain: normalizeDomain(input.domain), tags, source: input.source ?? null,
    ats_platform: input.ats_platform ?? null, ats_slug: input.ats_slug ?? null, resolved,
  });
}

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

export const bumpResolveAttempt = (id: number): void => {
  db.prepare(
    "UPDATE companies SET resolve_attempts = resolve_attempts + 1, last_resolve_attempt_at = datetime('now') WHERE id = ?",
  ).run(id);
};

const countOf = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { c: number }).c;
export interface Counts {
  companies: number; unresolved: number; jobs: number; ungraded: number;
  portfolio: number; portfolio_graded: number; dimensions_assessed: number;
  interviews_complete: number; interviews_open: number; plan_open: number;
}
export const counts = (): Counts => ({
  companies: countOf("SELECT count(*) c FROM companies"),
  unresolved: countOf("SELECT count(*) c FROM companies WHERE resolved = 0"),
  jobs: countOf("SELECT count(*) c FROM jobs"),
  ungraded: countOf("SELECT count(*) c FROM jobs WHERE grade_seniority IS NULL"),
  portfolio: countOf("SELECT count(*) c FROM portfolio_projects"),
  portfolio_graded: countOf("SELECT count(*) c FROM portfolio_relevance"),
  dimensions_assessed: countOf("SELECT count(*) c FROM competency_profile"),
  interviews_complete: countOf("SELECT count(*) c FROM interviews WHERE status='complete'"),
  interviews_open: countOf("SELECT count(*) c FROM interviews WHERE status='in_progress'"),
  plan_open: countOf("SELECT count(*) c FROM upskilling_plan WHERE status != 'done'"),
});

export const nowStr = (): string => (db.prepare("SELECT datetime('now') t").get() as { t: string }).t;
