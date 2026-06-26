// tools.ts — the MCP surface (see the README). The agent calls these in any order.
// Nine tools: three doors over uniform data (orient / look / gather) plus six
// named writes. Invariants: the agent never writes the DB (tools do, via db.ts);
// judgment enters only through a named structured-write tool whose closed
// vocabularies are z.enums built from a grading mode, so the agent sees the valid
// values and the mode is the single source of truth. No tool uses a union input
// schema (max client compatibility); conditional requirements degrade with an
// honest note rather than throwing, so every tool is safe in any call order.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import * as DB from "./db.js";
import { readJourneyState } from "./state.js";
import { resolveAts, fetchBoard, type AtsPlatform } from "./ats.js";
import { fetchUserRepos, type RepoFacts } from "./github.js";
import { getPool, type PoolAdapter } from "./pool.js";
import type { CatalogSnapshot, SnapshotJob, SnapshotCompany } from "./db.js";
import { PROVIDERS, type DiscoverQuery, type DiscoveredCompany, type ProviderContext } from "./providers.js";

type State = ReturnType<typeof readJourneyState>;

// Per-run spend ceiling for paid discovery — the confirmation gate the TheirStack API
// itself doesn't provide (handoff §6). A run estimates cost (records × rate) for free
// first; above this it returns the estimate and waits for confirm:true rather than spend.
const MAX_CREDITS_PER_RUN = Number(process.env.THEIRSTACK_MAX_CREDITS_PER_RUN ?? 150);
// Discovery providers read their key from the local env (a data-source sense — NOT the
// model key, which never enters this passive server). Auto-recharge is never touched.
const providerContext = (): ProviderContext => ({ apiKey: process.env.THEIRSTACK_API_KEY });

// Capability flags — flip these on as the external integrations land, and replace
// the matching gather() step's planned() with the real persister. They keep every
// tool honest about what isn't available yet instead of pointing at inert stubs.
// WHEN YOU ENABLE A STEP (any flag): also update the "Availability"/"Next"
// notes in the three skills (skills/{coach,job-search,application}/SKILL.md). The
// runtime self-corrects (pending_tools drops the step), but the skill prose — which
// says the step is "next/pending" — does not, so refresh it to match.
// Discovery splits into two steps with opposite cost profiles (see the dev handoff
// §5): find_companies (lead-gen → ATS-slug resolution) is the priced/built arm;
// fetch_jobs (keyless per-slug ATS pull) lands next. They flip independently.
const FIND_COMPANIES_AVAILABLE = true;    // gather: find_companies — lead-gen + ATS-slug resolution
const FETCH_JOBS_AVAILABLE = true;        // gather: fetch_jobs — live ATS board → raw jobs
const PORTFOLIO_INGEST_AVAILABLE = true;  // gather: ingest_portfolio — public GitHub repos
const SYNC_AVAILABLE = true;              // gather: sync_catalog — bidirectional pool sync
const pendingSteps = (): string[] => [
  ...(!FIND_COMPANIES_AVAILABLE ? ["find_companies"] : []),
  ...(!FETCH_JOBS_AVAILABLE ? ["fetch_jobs"] : []),
  ...(!PORTFOLIO_INGEST_AVAILABLE ? ["ingest_portfolio"] : []),
  ...(!SYNC_AVAILABLE ? ["sync_catalog"] : []),
];
const pendingTools = (): string[] => pendingSteps().map((s) => `gather(${s})`);

// Only the prep steps the user hasn't done yet — so a fully-prepped (or opted-out)
// user is never told to redo onboarding/assessment/resume.
const prepHint = (s: State) => {
  const steps: string[] = [];
  if (!s.dimensions.onboarded) steps.push("onboard");
  if (!s.dimensions.level_assessed) steps.push("assess your level");
  if (s.profile?.no_resume) steps.push("prep from your self-described projects");
  else if (!s.has_resume) steps.push("prep your resume");
  return steps.length ? steps.join(", ") : "sharpen your resume and portfolio against real demand";
};
// The job catalog can be empty for two different reasons: no companies discovered yet,
// or companies discovered but their boards not pulled yet. Say which, and the next step.
const emptyCatalogNote = (s: State) =>
  s.catalog.companies === 0
    ? `no jobs yet — discover target companies with gather({ step: 'find_companies' }), then pull their boards with gather({ step: 'fetch_jobs' }). You can also ${prepHint(s)} now.`
    : `${s.catalog.companies} companies discovered but no jobs pulled yet — run gather({ step: 'fetch_jobs' }) to fetch their live boards${s.catalog.unresolved > 0 ? ` (${s.catalog.unresolved} have no ATS slug yet and can't be fetched until resolved)` : ""}. You can also ${prepHint(s)} now.`;
const marketOverlay = (s: State) =>
  s.catalog.jobs === 0
    ? "(no market data yet — discover companies via gather 'find_companies' and pull their boards via gather 'fetch_jobs'; until then coach on resume structure/clarity/impact and don't fabricate demand)"
    : "(market-demand overlay isn't computed in this build yet — derive the delta from look({ at: 'jobs' }) + each job's skills for now)";

// Modes are the single source of truth for the closed vocabularies. loadMode does
// NOT swallow errors: a missing/corrupt mode fails the server at startup (loud),
// rather than silently drifting from a hardcoded fallback. cover_letter is loaded
// too so record_cover_letter is a genuinely mode-governed judgment write.
interface ModeConstraints {
  level_must_be_one_of?: string[];
  market_signal_must_be_one_of?: string[];
  band_must_be_one_of?: string[];
  [key: string]: unknown;
}
interface Mode { mode: string; rubric?: string; output_schema?: Record<string, string>; constraints: ModeConstraints }
function loadMode(name: string): Mode {
  return JSON.parse(readFileSync(new URL(`../modes/${name}.json`, import.meta.url), "utf8")) as Mode;
}
const MODE = {
  level: loadMode("level_assessment"),
  job: loadMode("job_intrinsic"),
  fit: loadMode("user_fit"),
  letter: loadMode("cover_letter"),
};
// The `!` asserts the closed-vocabulary key exists in the mode file; if it's missing,
// the z.enum built from it throws at startup — the intended loud failure.
const SENIORITY: string[] = MODE.level.constraints.level_must_be_one_of!;
const MARKET: string[] = MODE.job.constraints.market_signal_must_be_one_of!;
const FIT: string[] = MODE.fit.constraints.band_must_be_one_of!;
const enumOf = (v: string[]) => z.enum(v as [string, ...string[]]);
const ladder = SENIORITY.join(" → ");

// The user's level ±1 band, or null if no (valid) level is assessed. Shared by
// orient('dashboard') and look(at:'jobs', scope:'relevant') so the band math lives
// in one place.
function bandFor(level: string | null): string[] | null {
  if (!level) return null;
  const r = SENIORITY.indexOf(level);
  if (r < 0) return null;
  return SENIORITY.slice(Math.max(0, r - 1), r + 2);
}

const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const planned = (note: string) => json({ status: "planned", note: `${note} (external integration — implemented in a later pass).` });
const noJob = (id: number) => json({ ok: false, error: `no job ${id} — find a valid job_id via look({ at: 'jobs' })` });

// Shared job filters for look(at:'jobs'), applied across all three scopes so the agent can
// triage a large pull (thousands of postings) down to its lanes in one call: titles_any
// OR-matches keywords against the title, location is a substring match, remote keeps only
// remote-flagged rows, query matches title-or-company. Returns parameterized clauses (no
// string interpolation of user input → injection-safe). Assumes the query joins jobs j and
// companies c. Exported for direct testing.
export interface JobFilterArgs { query?: string; titles_any?: string[]; location?: string; remote?: boolean }
export function jobFilters(a: JobFilterArgs): { where: string[]; args: (string | number)[] } {
  const where: string[] = []; const args: (string | number)[] = [];
  if (a.query) { where.push("(j.title LIKE ? OR c.name LIKE ?)"); args.push(`%${a.query}%`, `%${a.query}%`); }
  if (a.titles_any?.length) {
    where.push("(" + a.titles_any.map(() => "j.title LIKE ?").join(" OR ") + ")");
    for (const t of a.titles_any) args.push(`%${t}%`);
  }
  if (a.location) { where.push("j.location LIKE ?"); args.push(`%${a.location}%`); }
  if (a.remote === true) where.push("j.remote = 1");
  return { where, args };
}

export function registerTools(server: McpServer): void {
  // ── orient: the one state door ────────────────────────────────────────────
  server.registerTool("orient", {
    description:
      "Start here. Where the user is in the journey, which skill fits right now, and which tools aren't built yet in this build. detail: 'recommend' (default) adds the skill to use now; 'raw' returns the journey state (+ pending_tools) for rehydrating after a reset; 'dashboard' adds the relevant-vs-whole-market gap and honest next-step notes. Safe as the first call; takes no required args.",
    inputSchema: { detail: enumOf(["recommend", "raw", "dashboard"]).optional() },
  }, async (a) => {
    const detail = a.detail ?? "recommend";
    const s = readJourneyState();
    if (detail === "raw") return json({ ...s, pending_tools: pendingTools() }); // rehydrate blackboard + what's pending

    const base: Record<string, unknown> = { server: "jobbot9000", state: s, pending_tools: pendingTools() };
    if (detail === "recommend") {
      base.recommended_skill = !s.dimensions.onboarded ? "coach — onboard first"
        : !s.dimensions.level_assessed ? "coach — assess the user's level (the keystone)"
        : s.catalog.jobs === 0 ? (s.catalog.companies === 0
            ? `coach — ${prepHint(s)}; then build your target list with gather('find_companies') and pull boards with gather('fetch_jobs')`
            : `job-search — you have ${s.catalog.companies} companies but no jobs yet; run gather('fetch_jobs') to populate them, then grade`)
        : "job-search or application";
      base.tool_discovery = "your client already has the full tool list; pending_tools above are the gather steps not yet functional in this build.";
      base.pending_note = "pending tools are integrations that ship later — nothing is broken; coaching + prep is the full first-run experience.";
      return json(base);
    }
    // dashboard
    let gap: Record<string, unknown> = { note: "assess the level to compute the relevant band" };
    const band = bandFor(s.assessed_level);
    if (band) {
      const relevant = (DB.db.prepare(
        `SELECT count(*) c FROM jobs WHERE still_live=1 AND grade_seniority IN (${band.map(() => "?").join(",")})`,
      ).get(...band) as { c: number }).c;
      gap = { relevant_in_band: relevant, whole_market: s.catalog.jobs, ungraded: s.catalog.ungraded_jobs, band };
      if (s.catalog.jobs === 0) gap.note = "zeros reflect an unpopulated catalog (discover companies, then gather 'fetch_jobs'), not measured market demand";
      else if (s.catalog.ungraded_jobs > 0) gap.note = `${s.catalog.ungraded_jobs} jobs ungraded — grade them (look scope:'worklist') before reading the band count as final`;
    }
    const notes: string[] = [];
    if (s.catalog.jobs === 0)
      notes.push(s.catalog.companies === 0
        ? `no companies discovered yet — run gather({ step: 'find_companies' }) to build the target catalog, then gather({ step: 'fetch_jobs' }) to pull their boards. You can ${prepHint(s)} now.`
        : `${s.catalog.companies} companies discovered${s.catalog.unresolved > 0 ? ` (${s.catalog.unresolved} still unresolved — no ATS slug yet)` : ""} but no jobs pulled — run gather({ step: 'fetch_jobs' }) to fetch their live boards. You can also ${prepHint(s)} now.`);
    if (s.profile?.no_resume || s.profile?.no_github)
      notes.push("the user opted out of a resume/GitHub — coach from their self-described projects and self-reported level (mark it as self-reported).");
    if (s.profile?.github_handle && !s.dimensions.portfolio_fetched && !s.profile.no_github)
      notes.push(PORTFOLIO_INGEST_AVAILABLE ? "GitHub handle on file — run gather({ step: 'ingest_portfolio' }) to enable portfolio coaching." : "GitHub handle on file, but GitHub ingestion isn't available in this build yet.");
    base.market_readiness_gap = gap;
    base.notes = notes;
    base.summary_note = "the honest read is yours to deliver — this only surfaces the numbers";
    return json(base);
  });

  // ── look: the one read door (never fetches, never writes) ─────────────────
  server.registerTool("look", {
    description:
      `The one read door — never fetches, never writes, safe in any order. at='jobs' lists jobs by scope: 'market' (default, whole catalog), 'relevant' (your level ±1 band with fit; levels ${ladder}), 'worklist' (the canonical grading queue — ungraded/stale rows). All three scopes accept the same filters — use them to TRIAGE a big pull down to your lanes in ONE call instead of many: titles_any (string[], OR-match any keyword against the job title), location (substring, e.g. 'US' or 'Remote'), remote (true = only remote-flagged), query (title OR company substring); grading_status filters market/worklist. e.g. look({at:'jobs',scope:'worklist',titles_any:['Applied AI','Forward Deployed','Data Engineer'],remote:true}) → the gradeable shortlist. Results carry location/remote/comp so you can geo-filter without opening a packet. 'relevant' vs 'market' is a deliberate pair — the gap is the signal (for a precomputed gap use orient detail:'dashboard'). at='companies' lists discovered companies. at='resume' / 'portfolio' read your materials; with_market_overlay adds the live-demand delta. at='packet' (needs job_id) gathers job + grade + skills + resume + fit + portfolio + any saved letter. Returns JSON for you to interpret.`,
    inputSchema: {
      at: enumOf(["jobs", "companies", "resume", "portfolio", "packet"]),
      scope: enumOf(["relevant", "market", "worklist"]).optional(),
      query: z.string().optional(),
      titles_any: z.array(z.string()).optional(),
      location: z.string().optional(),
      remote: z.boolean().optional(),
      grading_status: enumOf(["ungraded", "graded", "any"]).optional(),
      job_id: z.number().int().optional(),
      with_market_overlay: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    const s = readJourneyState();

    if (a.at === "companies") {
      // Surface the comma-delimited `tags` column as an array, and `resolved` as a
      // readable status, so the agent reads structured fields rather than raw storage.
      const companies = DB.getCompanies(a.limit ?? 200).map((c) => ({
        ...c,
        tags: c.tags ? c.tags.split(",").filter(Boolean) : [],
        ats_status: c.resolved ? "resolved" : "unresolved",
      }));
      const out: Record<string, unknown> = { companies };
      if (companies.length === 0) out.note = FIND_COMPANIES_AVAILABLE ? "no companies yet — run gather({ step: 'find_companies' })." : "no companies discovered yet — automated discovery isn't available in this build yet.";
      return json(out);
    }

    if (a.at === "resume") {
      const resume = DB.getMasterResume();
      if (!a.with_market_overlay) return json(resume ?? { content: null, note: "no resume captured yet" });
      if (!resume) {
        if (s.profile?.no_resume) return json({ opted_out: true, note: "The user opted out of a resume — coach on their self-reported level + (once available) market data. They can add one anytime via replace_master_resume (or re-run capture_onboarding_profile)." });
        return json({ note: "no resume yet — capture one via capture_onboarding_profile (or replace_master_resume)" });
      }
      return json({ resume: resume.content, market_overlay: marketOverlay(s) });
    }

    if (a.at === "portfolio") {
      const repos = DB.getPortfolio();
      if (repos.length === 0) {
        if (s.profile?.no_github) return json({ opted_out: true, note: "The user opted out of GitHub — coach from projects they describe in chat." });
        return json({ note: PORTFOLIO_INGEST_AVAILABLE ? "no portfolio yet — run gather({ step: 'ingest_portfolio' })" : "no portfolio captured yet, and GitHub ingestion isn't available in this build yet — ask the user to describe their projects and coach from that." });
      }
      // Surface the stored facts blob as structured fields (parsed) rather than raw JSON.
      const portfolio = repos.map((r) => ({ ...(r.facts_json ? JSON.parse(r.facts_json) : { repo: r.repo }), fetched_at: r.fetched_at }));
      return json({ portfolio, coverage_gaps: marketOverlay(s) });
    }

    if (a.at === "packet") {
      if (a.job_id === undefined) return json({ ok: false, error: "look({ at: 'packet' }) needs a job_id — find one via look({ at: 'jobs' })." });
      const job = DB.getJob(a.job_id);
      if (!job) return noJob(a.job_id);
      const master_resume = DB.getMasterResume()?.content ?? null;
      const fitRow = DB.db.prepare("SELECT band, gaps_json, rationale FROM job_fit WHERE job_id=?").get(a.job_id) as { band: string; gaps_json: string | null; rationale: string | null } | undefined;
      const fit = fitRow ? { band: fitRow.band, gaps: fitRow.gaps_json ? JSON.parse(fitRow.gaps_json) : [], rationale: fitRow.rationale } : null;
      const saved = DB.getCoverLetter(a.job_id);
      const missing: string[] = [];
      if (!master_resume) missing.push("master_resume");
      if (!fit) missing.push("fit");
      if (job.grade_seniority == null) missing.push("job_grade");
      return json({
        job, job_skills: DB.getJobSkills(a.job_id), master_resume, fit, portfolio: DB.getPortfolio(),
        saved_cover_letter: saved, missing,
        cover_letter_slot: missing.length
          ? `write the cover letter, then persist via record_cover_letter — but note it will be generic/ungrounded without: ${missing.join(", ")}. Don't fabricate the missing inputs.`
          : saved
            ? "a cover letter is already saved — refine it only if the packet changed, then persist via record_cover_letter."
            : "write the cover letter, then persist via record_cover_letter.",
      });
    }

    // a.at === "jobs"
    const scope = a.scope ?? "market";

    if (scope === "relevant") {
      const limit = a.limit ?? 25;
      if (s.catalog.jobs === 0) return json({ band: bandFor(s.assessed_level), jobs: [], catalog_empty: true, note: emptyCatalogNote(s) });
      const band = bandFor(s.assessed_level);
      if (!band) {
        const rows = DB.db.prepare("SELECT j.id, c.name AS company, j.title, j.grade_seniority FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.still_live=1 ORDER BY j.last_seen_at DESC LIMIT ?").all(limit);
        return json({ band: null, low_confidence: true, jobs: rows, note: "level not assessed yet — returning a recent slice (low confidence). Assess via record_level_assessment for an accurate band." });
      }
      const flt = jobFilters(a);
      const rows = DB.db.prepare(
        `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.comp_min, j.comp_max, j.grade_seniority, j.grade_market_signal,
                f.band AS fit, f.gaps_json AS fit_gaps_json, f.rationale AS fit_rationale
         FROM jobs j JOIN companies c ON c.id=j.company_id
         LEFT JOIN job_fit f ON f.job_id=j.id
         WHERE j.still_live=1 AND j.grade_seniority IN (${band.map(() => "?").join(",")})${flt.where.length ? " AND " + flt.where.join(" AND ") : ""}
         ORDER BY j.last_seen_at DESC LIMIT ?`,
      ).all(...band, ...flt.args, limit) as any[];
      const jobs = rows.map(({ fit_gaps_json, ...rest }) => ({ ...rest, fit_gaps: fit_gaps_json ? JSON.parse(fit_gaps_json) : null }));
      return json({ band, jobs });
    }

    if (scope === "worklist") {
      const flt = jobFilters(a);
      const where = ["j.still_live=1", "(j.grade_seniority IS NULL OR j.graded_at < j.fetched_at)", ...flt.where];
      const rows = DB.db.prepare(
        `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.raw_json, j.fetched_at, j.graded_at,
                CASE WHEN j.grade_seniority IS NULL THEN 'never_graded' ELSE 'stale' END AS reason
         FROM jobs j JOIN companies c ON c.id=j.company_id
         WHERE ${where.join(" AND ")} ORDER BY j.fetched_at ASC LIMIT ?`,
      ).all(...flt.args, a.limit ?? 25);
      const out: Record<string, unknown> = { count: rows.length, jobs: rows };
      if (rows.length === 0) out.note = s.catalog.jobs === 0 ? emptyCatalogNote(s) : "no ungraded jobs match (all graded, or the filter is too narrow).";
      return json(out);
    }

    // scope === "market" — whole-market view + general catalog search
    const limit = a.limit ?? 50;
    const flt = jobFilters(a);
    const where = ["j.still_live=1", ...flt.where];
    if (a.grading_status === "ungraded") where.push("j.grade_seniority IS NULL");
    if (a.grading_status === "graded") where.push("j.grade_seniority IS NOT NULL");
    const rows = DB.db.prepare(
      `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.comp_min, j.comp_max, j.grade_seniority
       FROM jobs j JOIN companies c ON c.id=j.company_id
       WHERE ${where.join(" AND ")} ORDER BY j.last_seen_at DESC LIMIT ?`,
    ).all(...flt.args, limit);
    const out: Record<string, unknown> = { count: rows.length, jobs: rows };
    if (s.catalog.jobs === 0) out.note = emptyCatalogNote(s);
    return json(out);
  });

  // ── onboarding & profile (personal, mechanical writes) ────────────────────
  server.registerTool("capture_onboarding_profile", {
    description: "Front door: capture resume, GitHub handle, and target work. Idempotent; partial input ('no resume'/'no github') is fine.",
    inputSchema: {
      resume: z.string().optional(), no_resume: z.boolean().optional(),
      github_handle: z.string().optional(), no_github: z.boolean().optional(),
      target_role: z.string().optional(), target_niche: z.string().optional(), location_pref: z.string().optional(),
    },
  }, async (a) => {
    if (a.resume) DB.setMasterResume(a.resume);
    const patch: any = {};
    for (const k of ["target_role", "target_niche", "location_pref", "github_handle"] as const)
      if (a[k] !== undefined) patch[k] = a[k];
    if (a.no_resume !== undefined) patch.no_resume = a.no_resume ? 1 : 0;
    if (a.no_github !== undefined) patch.no_github = a.no_github ? 1 : 0;
    DB.upsertProfile(patch);
    return json({ ok: true, state: readJourneyState() });
  });

  server.registerTool("replace_master_resume", {
    description: "Replace the master resume wholesale. There is only one resume; the user's edits land here. Read it back via look({ at: 'resume' }).",
    inputSchema: { content: z.string().min(1) },
  }, async (a) => { DB.setMasterResume(a.content); return json({ ok: true, updated: DB.getMasterResume()?.updated_at }); });

  // ── structured writes (judgment, vocab enforced by the grading mode) ──────
  server.registerTool("record_level_assessment", {
    description: `Set the user's level + rationale. → personal. The keystone judgment — it shapes every later return. Mode: level_assessment. Ladder: ${ladder}.`,
    inputSchema: { level: enumOf(SENIORITY), rationale: z.string().min(1), evidence: z.array(z.string()).optional() },
  }, async (a) => { DB.setAssessment(a.level, a.rationale, a.evidence ?? []); return json({ ok: true, assessed_level: a.level }); });

  server.registerTool("grade_job", {
    description: `A job's intrinsic grade: seniority (${ladder}), market signal, required-vs-preferred skills. → catalog (shareable — the ONLY write to the synced plane). Mode: job_intrinsic.`,
    inputSchema: {
      job_id: z.number().int(), seniority: enumOf(SENIORITY), market_signal: enumOf(MARKET),
      skills: z.array(z.object({ skill: z.string(), kind: enumOf(["required", "preferred"]) })),
    },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    DB.setJobGrade(a.job_id, a.seniority, a.market_signal, a.skills);
    return json({ ok: true, job_id: a.job_id });
  });

  server.registerTool("grade_job_fit", {
    description: "The user's fit on a job (over/exactly/under-qualified + gaps), measured against the assessed level. → personal (never shared). Mode: user_fit. Requires a level assessment first.",
    inputSchema: { job_id: z.number().int(), band: enumOf(FIT), gaps: z.array(z.string()).optional(), rationale: z.string().min(1) },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    if (!readJourneyState().assessed_level)
      return json({ ok: false, error: "assess the user's level first via record_level_assessment — fit is measured relative to it (see the user_fit mode's must_reference_assessed_level)." });
    DB.setJobFit(a.job_id, a.band, a.gaps ?? [], a.rationale);
    return json({ ok: true, job_id: a.job_id, band: a.band });
  });

  server.registerTool("record_cover_letter", {
    description: `Persist the agent-authored cover letter + talking points for a role. → personal. Mode: cover_letter (lead with a real angle; ${MODE.letter.constraints.no_invented_experience ? "no invented experience" : "stay grounded in the packet"}). The end-state deliverable; read it back via look({ at: 'packet' }).`,
    inputSchema: { job_id: z.number().int(), content: z.string().min(1), talking_points: z.array(z.string()).optional() },
  }, async (a) => {
    const job = DB.getJob(a.job_id);
    if (!job) return noJob(a.job_id);
    DB.recordCoverLetter(a.job_id, a.content, a.talking_points ?? []);
    const missing: string[] = [];
    if (!DB.getMasterResume()?.content) missing.push("master_resume");
    if (!DB.db.prepare("SELECT 1 FROM job_fit WHERE job_id=?").get(a.job_id)) missing.push("fit");
    if (job.grade_seniority == null) missing.push("job_grade");
    const out: Record<string, unknown> = { ok: true, job_id: a.job_id };
    if (missing.length) out.note = `saved — but this job is missing ${missing.join(", ")}, so the letter may be ungrounded. The cover_letter mode forbids inventing experience — don't fabricate those inputs.`;
    return json(out);
  });

  // ── gather: the one door to the outside world ─────────────────────────────
  const pending = pendingSteps();
  const gatherDesc =
    `${pending.length ? `[NOT YET AVAILABLE IN THIS BUILD: ${pending.join(", ")}] ` : ""}` +
    "The one door to the outside world — reach out and persist new data, then return it. step selects the integration: " +
    "'find_companies' (lead-gen → ATS-slug resolution; FREE by default. Lightest: pass companies:[{name,domain}] to resolve specific companies on demand, no key — and for a board whose slug isn't derivable from name/domain, PIN it directly: companies:[{name, ats_platform, ats_slug}] (slug-complete, skips resolution). Or build a query from the resume — titles/technologies/seniority/locations — for the free curated roster; pass provider:'theirstack' (+ THEIRSTACK_API_KEY) for paid targeted discovery, count-first and credit-ceiling-gated), " +
    "'fetch_jobs' (pull live ATS boards → raw, ungraded jobs; keyless. Target one board with ats_platform+ats_slug or company_id, or pass none to refresh all resolved companies (stalest first, bounded by limit). A liveness pass closes postings that vanished; grade the new jobs next), " +
    "'ingest_portfolio' (the user's public GitHub repos → portfolio facts for coaching; keyless. Uses the profile's github_handle, or pass one; forks skipped unless include_forks), " +
    "'sync_catalog' (bidirectional sync of PUBLIC catalog data only — companies + jobs + grades — with a shared pool; personal data never leaves. Opt-in: needs JOBBOT_POOL_URL configured. dry_run shows the push/pull diff without sending or writing anything). " +
    "Persistence is a side effect of gathering — the agent still never writes the DB itself.";
  server.registerTool("gather", {
    description: gatherDesc,
    inputSchema: {
      step: enumOf(["find_companies", "fetch_jobs", "ingest_portfolio", "sync_catalog"]),
      // find_companies — on-demand (free, zero-config): name companies to resolve directly.
      companies: z.array(z.object({
        name: z.string(),
        domain: z.string().optional(),
        ats_platform: enumOf(["ashby", "greenhouse", "lever", "workable"]).optional(),
        ats_slug: z.string().optional(),
      })).optional(),
      // find_companies query (you build this from the resume — stages 1–2 are yours):
      titles: z.array(z.string()).optional(),
      technologies: z.array(z.string()).optional(),
      seniority: enumOf(["junior", "mid_level", "senior", "staff", "c_level"]).optional(),
      locations: z.array(z.string()).optional(),
      posted_within_days: z.number().int().positive().optional(),
      provider: z.string().optional(),     // default: 'curated' (free); 'theirstack' opt-in
      max_credits: z.number().int().positive().optional(), // override the per-run ceiling
      confirm: z.boolean().optional(),     // proceed with a paid pull above the ceiling
      niche: z.string().optional(),
      // fetch_jobs targets (all optional — none = refresh every resolved company):
      ats_platform: enumOf(["ashby", "greenhouse", "lever", "workable"]).optional(),
      ats_slug: z.string().optional(),
      company_id: z.number().int().optional(),
      github_handle: z.string().optional(),
      include_forks: z.boolean().optional(), // ingest_portfolio: keep forked repos (default: skip)
      dry_run: z.boolean().optional(),     // free count-first only — never spends
      limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    switch (a.step) {
      case "find_companies":
        return FIND_COMPANIES_AVAILABLE ? findCompanies(a) : planned("lead-gen + ATS-slug resolution");
      case "fetch_jobs":
        return FETCH_JOBS_AVAILABLE ? fetchJobs(a) : planned("fetch + normalize a live ATS board");
      case "ingest_portfolio":
        return PORTFOLIO_INGEST_AVAILABLE ? ingestPortfolio(a) : planned("fetch the user's public GitHub repos");
      case "sync_catalog":
        return SYNC_AVAILABLE ? syncCatalog(a) : planned("bidirectional catalog sync with an external pool");
      default: return json({ ok: false, error: `unknown gather step '${a.step}'` });
    }
  });
}

// ── find_companies orchestration (gather step 'find_companies') ──────────────
// Stages 3–4: discovery (a sense) → free ATS resolution → persist via db.ts (the sole
// writer). Stages 1–2 (resume → query) are the agent's; this receives the built query.
// DEFAULT IS FREE: no provider arg → the free curated roster; the zero-config on-demand
// path ('companies') is free too. TheirStack is opt-in (provider:'theirstack' + key).
// Cost-disciplined: count-first is free, paid pulls gate on a per-run credit ceiling,
// and persistence is idempotent (re-runs dedup on domain, never re-pay). `deps` is
// injectable so the whole path is testable offline against a mocked fetch.
interface FindArgs {
  titles?: string[]; technologies?: string[]; seniority?: string;
  locations?: string[]; posted_within_days?: number;
  // on-demand: resolve these directly (free). A company carrying ats_platform + ats_slug is
  // PINNED — taken slug-complete, skipping resolution (for boards whose slug isn't derivable
  // from name/domain, e.g. Greenhouse token 'gleanwork' for Glean).
  companies?: { name: string; domain?: string; ats_platform?: string; ats_slug?: string }[];
  provider?: string; max_credits?: number; confirm?: boolean; dry_run?: boolean; limit?: number;
}
interface FindDeps { ctx?: ProviderContext; resolve?: typeof resolveAts }
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Resolve + persist a batch of discovered companies. Slug-complete entries skip
// resolution; name/domain entries resolve for free; unresolved-but-domained rows persist
// as candidates (dedupable on re-run); a row with neither slug nor domain is unfetchable
// and undedupable, so it's skipped rather than persisted as a re-inserting orphan.
async function persistDiscovered(companies: DiscoveredCompany[], resolve: typeof resolveAts) {
  let inserted = 0, resolved = 0, unresolved = 0, skipped = 0;
  for (const c of companies) {
    if (c.ats_platform && c.ats_slug) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags, ats_platform: c.ats_platform, ats_slug: c.ats_slug });
      if (up.inserted) inserted++;
      resolved++;
      continue;
    }
    const hit = await resolve({ name: c.name, domain: c.domain });
    if (hit) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags, ats_platform: hit.platform, ats_slug: hit.slug });
      if (up.inserted) inserted++;
      resolved++;
    } else if (c.domain) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags }); // resolved=0
      if (up.inserted) inserted++;
      DB.bumpResolveAttempt(up.id);
      unresolved++;
    } else {
      skipped++;
    }
  }
  return { inserted, resolved, unresolved, skipped };
}

const nextNote = () => FETCH_JOBS_AVAILABLE
  ? "resolved companies are ready — pull their live boards with gather({ step: 'fetch_jobs', ats_platform, ats_slug })."
  : "companies are in the catalog; pulling their live jobs (gather 'fetch_jobs') ships next. Unresolved rows have no ATS slug yet.";

export async function findCompanies(a: FindArgs, deps: FindDeps = {}) {
  const resolve = deps.resolve ?? resolveAts;

  // ── On-demand path (free, zero-config): the user named specific companies. Resolve and
  // persist them directly — no provider, no count, no key. The lightest free path.
  if (a.companies?.length) {
    // A company with both ats_platform + ats_slug is PINNED (slug-complete → skips
    // resolution); name/domain-only entries resolve normally. Pinning needs both halves —
    // a lone ats_platform or ats_slug is ignored and the entry resolves by name/domain.
    const discovered: DiscoveredCompany[] = a.companies.map((c) => ({
      name: c.name, domain: c.domain ?? null, tags: [], source: "manual",
      ats_platform: (c.ats_platform && c.ats_slug) ? c.ats_platform : null,
      ats_slug: (c.ats_platform && c.ats_slug) ? c.ats_slug : null,
    }));
    const persisted = await persistDiscovered(discovered, resolve);
    const pinned = a.companies.filter((c) => c.ats_platform && c.ats_slug).length;
    const out: Record<string, unknown> = { ok: true, mode: "on_demand", credits_spent: 0, discovered: discovered.length, persisted, catalog: readJourneyState().catalog, next: nextNote() };
    if (pinned) out.note = `${pinned} board(s) pinned by explicit ats_platform/ats_slug (slug-complete, not re-verified — gather('fetch_jobs') confirms them when it pulls).`;
    return json(out);
  }

  // ── Provider discovery path. Default provider is the free curated roster.
  const providerName = a.provider ?? Object.keys(PROVIDERS)[0];
  const provider = PROVIDERS[providerName];
  if (!provider) return json({ ok: false, error: `unknown provider '${providerName}' — available: ${Object.keys(PROVIDERS).join(", ") || "(none)"}` });

  const ctx = deps.ctx ?? providerContext();
  if (!provider.available(ctx))
    return json({ ok: false, error: `provider '${provider.name}' is unavailable${provider.requiresKey ? " — set THEIRSTACK_API_KEY in the local env to opt into paid targeting (a data-source key; the model key never enters the server). The free 'curated' provider and the 'companies' on-demand path need no key." : "."}` });

  const q: DiscoverQuery = {
    titles: a.titles, technologies: a.technologies, seniority: a.seniority ?? null,
    locations: a.locations, posted_within_days: a.posted_within_days, limit: a.limit,
  };

  let est;
  try { est = await provider.estimate(q, ctx); }            // FREE count-first
  catch (e) { return json({ ok: false, error: `discovery pre-flight failed: ${errMsg(e)}` }); }

  const ceiling = a.max_credits ?? MAX_CREDITS_PER_RUN;
  if (a.dry_run)
    return json({ ok: true, dry_run: true, provider: provider.name, estimate: est, ceiling, note: est.projected_credits === 0 ? "free provider — no spend; re-run without dry_run to persist." : "free count only — re-run without dry_run to pull (paid)." });
  if (est.projected_credits > ceiling && !a.confirm)
    return json({ ok: false, confirmation_required: true, provider: provider.name, estimate: est, ceiling,
      note: `projected ~${est.projected_credits} credits exceeds the per-run ceiling (${ceiling}). Re-run with confirm:true to proceed, or lower limit / raise max_credits.` });

  let result;
  try { result = await provider.discover(q, ctx); }
  catch (e) { return json({ ok: false, error: `discovery failed: ${errMsg(e)}` }); }

  const persisted = await persistDiscovered(result.companies, resolve);
  const out: Record<string, unknown> = {
    ok: true, provider: provider.name, estimate: est, credits_spent: result.records_billed,
    discovered: result.companies.length, persisted, catalog: readJourneyState().catalog, next: nextNote(),
  };
  // Honest guidance when the default free roster is empty — point at the paths that work now.
  if (result.companies.length === 0 && provider.name === "curated")
    out.note = "the curated seed roster is empty. Name companies directly to add them now — gather({ step: 'find_companies', companies: [{ name, domain }] }) — or add entries to seeds/companies.json, or set THEIRSTACK_API_KEY and pass provider:'theirstack' for paid targeted discovery.";
  return json(out);
}

// ── fetch_jobs orchestration (gather step 'fetch_jobs') ──────────────────────
// Keyless: pull one or many ATS boards, normalize, and persist via db.ts (the sole
// writer). Targets: ats_platform+ats_slug (one board; auto-creates a minimal resolved
// company if that slug is new), company_id (one known company), or none (refresh all
// resolved companies, stalest-first, bounded by limit). An UNREACHABLE board (null) is
// reported and skipped — never persisted, so a transient 404 never closes a whole
// company; a valid EMPTY board ([]) closes that company's stale postings via the liveness
// pass. `deps` is injectable so the whole path is testable offline against a mocked fetch.
interface FetchArgs { ats_platform?: string; ats_slug?: string; company_id?: number; limit?: number }
interface FetchTarget { company_id: number; platform: AtsPlatform; slug: string; name: string }
interface FetchDeps {
  fetchBoardFn?: typeof fetchBoard;
  sleep?: (ms: number) => Promise<void>;
  politeDelayMs?: number; // between consecutive boards (Lever asks ~1s); 0 in tests
}
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchJobs(a: FetchArgs, deps: FetchDeps = {}) {
  const fetchBoardFn = deps.fetchBoardFn ?? fetchBoard;
  const sleep = deps.sleep ?? realSleep;
  const politeDelayMs = deps.politeDelayMs ?? 1000;

  // ── resolve the target list ────────────────────────────────────────────────
  const targets: FetchTarget[] = [];
  if (a.ats_platform && a.ats_slug) {
    const platform = a.ats_platform as AtsPlatform; // constrained by the gather enum
    const existing = DB.getCompanyByAts(platform, a.ats_slug);
    const id = existing?.id ?? DB.upsertCompany({ name: a.ats_slug, ats_platform: platform, ats_slug: a.ats_slug, source: "manual" }).id;
    targets.push({ company_id: id, platform, slug: a.ats_slug, name: existing?.name ?? a.ats_slug });
  } else if (a.company_id !== undefined) {
    const c = DB.db.prepare("SELECT id, name, ats_platform, ats_slug FROM companies WHERE id=?").get(a.company_id) as
      { id: number; name: string; ats_platform: string | null; ats_slug: string | null } | undefined;
    if (!c) return json({ ok: false, error: `no company ${a.company_id} — list companies via look({ at: 'companies' }).` });
    if (!c.ats_platform || !c.ats_slug) return json({ ok: false, error: `company ${a.company_id} (${c.name}) has no ATS slug yet — resolve it via gather('find_companies') first.` });
    targets.push({ company_id: c.id, platform: c.ats_platform as AtsPlatform, slug: c.ats_slug, name: c.name });
  } else {
    for (const c of DB.getResolvedCompanies(a.limit ?? 25))
      targets.push({ company_id: c.id, platform: c.ats_platform as AtsPlatform, slug: c.ats_slug!, name: c.name });
  }
  if (targets.length === 0)
    return json({ ok: true, boards_fetched: 0, note: "no resolved companies to fetch — discover and resolve some via gather('find_companies'), or target a board with ats_platform + ats_slug." });

  // ── fetch each board, persist via db.ts ────────────────────────────────────
  const totals = { inserted: 0, updated: 0, closed: 0 };
  const per_company: Record<string, unknown>[] = [];
  let unreachable = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (i > 0 && politeDelayMs > 0) await sleep(politeDelayMs); // be polite between boards
    let board;
    try { board = await fetchBoardFn(t.platform, t.slug); }
    catch { board = null; }
    if (board === null) { // unreachable — skip, do NOT touch liveness
      unreachable++;
      per_company.push({ company_id: t.company_id, name: t.name, platform: t.platform, slug: t.slug, unreachable: true });
      continue;
    }
    const r = DB.upsertJobs(t.company_id, board);
    totals.inserted += r.inserted; totals.updated += r.updated; totals.closed += r.closed;
    per_company.push({ company_id: t.company_id, name: t.name, platform: t.platform, slug: t.slug, ...r });
  }

  return json({
    ok: true,
    boards_fetched: targets.length - unreachable,
    unreachable,
    jobs: totals,
    per_company,
    catalog: readJourneyState().catalog,
    next: totals.inserted + totals.updated > 0
      ? "grade the new jobs — look({ at: 'jobs', scope: 'worklist' }) for the queue, then grade_job + grade_job_fit."
      : "no live postings found on these boards (or all unreachable). Try other companies, or coach from the resume.",
  });
}

// ── ingest_portfolio orchestration (gather step 'ingest_portfolio') ──────────
// Keyless: fetch the user's public GitHub repos as structured facts and store a fresh
// snapshot via db.ts (the sole writer). A SENSE only — the agent reads the facts via
// look({ at: 'portfolio' }) and does the judging (which to feature, architecture read).
// Honors the no_github opt-out; persists a passed handle to the profile. `deps` is
// injectable so the path is testable offline against a mocked fetch.
interface IngestArgs { github_handle?: string; include_forks?: boolean }
interface IngestDeps { fetchReposFn?: typeof fetchUserRepos; token?: string }

export async function ingestPortfolio(a: IngestArgs, deps: IngestDeps = {}) {
  const s = readJourneyState();
  if (s.profile?.no_github)
    return json({ ok: false, error: "the user opted out of GitHub (no_github) — clear it via capture_onboarding_profile to ingest, or coach from projects they describe in chat." });
  const handle = a.github_handle ?? s.profile?.github_handle ?? undefined;
  if (!handle)
    return json({ ok: false, error: "no github_handle — pass one, or capture it via capture_onboarding_profile first." });

  const fetchReposFn = deps.fetchReposFn ?? fetchUserRepos;
  let repos: RepoFacts[];
  try { repos = await fetchReposFn(handle, { token: deps.token ?? process.env.GITHUB_TOKEN }); }
  catch (e) { return json({ ok: false, error: `GitHub fetch failed: ${errMsg(e)}` }); }

  const kept = a.include_forks ? repos : repos.filter((r) => !r.is_fork);
  DB.replacePortfolio(kept.map((r) => ({ repo: r.repo, facts: r })));
  // Persist a freshly-supplied handle so later calls (and orient) know it.
  if (a.github_handle && a.github_handle !== s.profile?.github_handle) DB.upsertProfile({ github_handle: a.github_handle });

  return json({
    ok: true,
    github_handle: handle,
    fetched: repos.length,
    kept: kept.length,
    forks_skipped: a.include_forks ? 0 : repos.length - kept.length,
    top_by_recent: kept.slice(0, 5).map((r) => ({ repo: r.repo, language: r.language, stars: r.stars, pushed_at: r.pushed_at })),
    portfolio_count: DB.counts().portfolio,
    next: kept.length === 0
      ? "no public repos found (or all forks). Coach from projects the user describes in chat instead."
      : "coach the portfolio against demand — look({ at: 'portfolio', with_market_overlay: true }); you pick which projects to feature.",
  });
}

// ── sync_catalog orchestration (gather step 'sync_catalog') ──────────────────
// The egress boundary. Bidirectional sync of PUBLIC catalog data only (the snapshot is
// built from the catalog plane in db.ts — personal data is structurally excluded). Opt-in:
// with no pool configured nothing leaves and we just report the local catalog. dry_run
// computes the push/pull diff in memory and writes/sends nothing. A real run pulls first
// (merge, newer-wins), then pushes local. Merge policy is the provisional default; see
// db.applyCatalogSnapshot (handoff §4 lists conflict resolution as an open question).
interface SyncArgs { dry_run?: boolean }
interface SyncDeps { pool?: PoolAdapter | null }

// Cross-instance natural keys (local ids are meaningless across the pool).
const companyKey = (c: SnapshotCompany) => (c.ats_platform && c.ats_slug ? `ats:${c.ats_platform}/${c.ats_slug}` : `dom:${c.domain ?? c.name}`);
const jobKey = (j: SnapshotJob) => `${j.ats_platform && j.ats_slug ? `ats:${j.ats_platform}/${j.ats_slug}` : `dom:${j.domain}`}|${j.source_url}`;
const jobNewer = (a: SnapshotJob, b: SnapshotJob) => a.last_seen_at > b.last_seen_at || (!!a.grade_seniority && !b.grade_seniority);

// Pure, in-memory diff between two snapshots — what a pull would add/refresh locally and
// what a push would contribute to the pool. No DB reads, no mutation; drives dry_run.
function diffCatalog(local: CatalogSnapshot, remote: CatalogSnapshot) {
  const lJobs = new Map(local.jobs.map((j) => [jobKey(j), j]));
  const rJobs = new Map(remote.jobs.map((j) => [jobKey(j), j]));
  const lCos = new Set(local.companies.map(companyKey));
  const rCos = new Set(remote.companies.map(companyKey));
  let pull_new = 0, pull_updated = 0, push_new = 0, push_updated = 0;
  for (const [k, rj] of rJobs) { const lj = lJobs.get(k); if (!lj) pull_new++; else if (jobNewer(rj, lj)) pull_updated++; }
  for (const [k, lj] of lJobs) { const rj = rJobs.get(k); if (!rj) push_new++; else if (jobNewer(lj, rj)) push_updated++; }
  return {
    pull: { companies_new: [...rCos].filter((k) => !lCos.has(k)).length, jobs_new: pull_new, jobs_updated: pull_updated },
    push: { companies_new: [...lCos].filter((k) => !rCos.has(k)).length, jobs_new: push_new, jobs_updated: push_updated },
  };
}

export async function syncCatalog(a: SyncArgs, deps: SyncDeps = {}) {
  const local = DB.catalogSnapshot();
  const pool = deps.pool !== undefined
    ? deps.pool
    : getPool({ url: process.env.JOBBOT_POOL_URL, token: process.env.JOBBOT_POOL_TOKEN });

  if (!pool)
    return json({
      ok: false, pool_configured: false,
      local_catalog: { companies: local.companies.length, jobs: local.jobs.length },
      note: "no shared catalog pool is configured — set JOBBOT_POOL_URL (and optionally JOBBOT_POOL_TOKEN) to enable sync. Only PUBLIC catalog data (companies + jobs + grades) would ever leave; personal data (resume, fit, cover letters) never syncs. No hosted pool ships with this build.",
    });

  let remote: CatalogSnapshot;
  try { remote = await pool.pull(); }
  catch (e) { return json({ ok: false, error: `pool pull failed: ${errMsg(e)}` }); }

  const diff = diffCatalog(local, remote);
  if (a.dry_run)
    return json({ ok: true, dry_run: true, pool: pool.name, diff, note: "dry run — nothing was sent or written. Re-run without dry_run to sync (pull-then-push). Only public catalog data is shared." });

  const pulled = DB.applyCatalogSnapshot(remote);   // pull + merge (newer-wins) first
  let pushed;
  try { pushed = await pool.push(local); }          // then push local (public catalog only)
  catch (e) { return json({ ok: false, error: `pool push failed (pull already applied locally): ${errMsg(e)}`, pulled }); }
  DB.setMeta("last_synced", DB.nowStr());

  return json({
    ok: true, pool: pool.name, pulled, pushed: pushed.accepted,
    catalog: readJourneyState().catalog,
    note: "synced — only public catalog data (companies + jobs + grades) was shared; personal data never left.",
  });
}
