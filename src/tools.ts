// tools.ts — the MCP surface (v2: the readiness loop). The agent calls these in any order.
// Three doors over uniform data (orient / look / gather) plus the writes. Invariants hold:
// the agent never writes the DB (db.ts does); judgment enters only through a named write whose
// closed vocabularies are z.enums built from a grading mode (the mode is the single source of
// truth); no union input schemas; every tool degrades with an honest note rather than throwing.
// New in v2: a multi-dimensional competency profile (fair to no-portfolio candidates — absence
// lowers CONFIDENCE, not the level), a repeatable interview that assesses + verifies + upskills,
// fitness×desire matching, a tracked upskilling plan, resume-building, and a durable journal so a
// months-long search resumes from the DB after any session ends.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import * as DB from "./db.js";
import { readJourneyState } from "./state.js";
import { resolveAts, fetchBoard, type AtsPlatform } from "./ats.js";
import { fetchUserRepos, enrichRepo, type RepoFacts } from "./github.js";
import { PROVIDERS, type DiscoverQuery, type DiscoveredCompany, type ProviderContext } from "./providers.js";

type State = ReturnType<typeof readJourneyState>;

// Per-run spend ceiling for paid discovery (the gate TheirStack itself doesn't provide).
const MAX_CREDITS_PER_RUN = Number(process.env.THEIRSTACK_MAX_CREDITS_PER_RUN ?? 150);
const providerContext = (): ProviderContext => ({ apiKey: process.env.THEIRSTACK_API_KEY });

// All three gather steps are wired and keyless-by-default; sync was cut in v2. pendingTools
// stays so a future gated step can re-use the honest "not yet" plumbing.
const pendingTools = (): string[] => [];

// ── grading modes — the single source of truth for the closed vocabularies ──
interface ModeConstraints { [key: string]: unknown }
interface Mode { mode: string; rubric?: string; output_schema?: Record<string, unknown>; constraints: ModeConstraints }
function loadMode(name: string): Mode {
  return JSON.parse(readFileSync(new URL(`../modes/${name}.json`, import.meta.url), "utf8")) as Mode;
}
const MODE = {
  competency: loadMode("competency_profile"),
  interview: loadMode("interview"),
  roleFit: loadMode("role_fit"),
  job: loadMode("job_intrinsic"),
  letter: loadMode("cover_letter"),
  portfolio: loadMode("portfolio_relevance"),
  plan: loadMode("upskilling_plan"),
  resume: loadMode("resume_revision"),
  outreach: loadMode("outreach"),
};
const vocab = (m: Mode, key: string): string[] => {
  const v = m.constraints[key];
  if (!Array.isArray(v)) throw new Error(`mode ${m.mode}: missing closed vocabulary '${key}'`); // loud startup failure
  return v as string[];
};
const SENIORITY = vocab(MODE.competency, "level_must_be_one_of");
const DIMENSION = vocab(MODE.competency, "dimension_must_be_one_of");
const CONFIDENCE = vocab(MODE.competency, "confidence_must_be_one_of");
const PROVENANCE = vocab(MODE.competency, "provenance_must_be_one_of");
const SCORE = vocab(MODE.interview, "score_must_be_one_of");
const OWNERSHIP = vocab(MODE.interview, "ownership_must_be_one_of");
const UNDERSTANDING = vocab(MODE.interview, "understanding_must_be_one_of");
const FITBAND = vocab(MODE.roleFit, "band_must_be_one_of");
const DESIRE_ALIGN = vocab(MODE.roleFit, "desire_alignment_must_be_one_of");
const MARKET = vocab(MODE.job, "market_signal_must_be_one_of");
const RELEVANCE = vocab(MODE.portfolio, "relevance_must_be_one_of");
const PLAN_TYPE = vocab(MODE.plan, "type_must_be_one_of");
const PLAN_STATUS = ["suggested", "in_progress", "done"];
const APP_STATUS = ["interested", "applied", "interviewing", "offer", "rejected", "withdrawn"];
const INTERVIEW_TYPE = ["competency", "role_fit"];
const enumOf = (v: string[]) => z.enum(v as [string, ...string[]]);
const ladder = SENIORITY.join(" → ");

// The user's level ±1 band (around the derived overall band), or null if unassessed.
function bandFor(level: string | null): string[] | null {
  if (!level) return null;
  const r = SENIORITY.indexOf(level);
  if (r < 0) return null;
  return SENIORITY.slice(Math.max(0, r - 1), r + 2);
}

const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const noJob = (id: number) => json({ ok: false, error: `no job ${id} — find a valid job_id via look({ at: 'jobs' })` });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const DESC_MAX = 1000;
export function compactDescription(rawJson: string | null): string | null {
  if (!rawJson) return null;
  let p: any; try { p = JSON.parse(rawJson); } catch { return null; }
  const raw = p?.descriptionPlain ?? p?.content ?? p?.description ?? p?.jobDescription ?? null;
  if (typeof raw !== "string" || !raw) return null;
  const text = raw.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, DESC_MAX) : null;
}

// Portfolio repos + relevance, ranked strong→moderate→weak→ungraded; spreads facts (incl. the
// verify signals + source) so the skeptical picture travels everywhere it's read.
export function rankedPortfolio(): Array<Record<string, unknown> & { relevance: { band: string; demonstrates: unknown[]; gaps: unknown[]; rationale: string | null } | null }> {
  const rank = (b?: string | null) => (b ? RELEVANCE.indexOf(b) : RELEVANCE.length);
  return DB.getPortfolio().map((r) => {
    const facts = r.facts_json ? JSON.parse(r.facts_json) : { repo: r.repo };
    const rel = DB.getPortfolioRelevance(r.repo);
    return { ...facts, source: r.source, fetched_at: r.fetched_at, relevance: rel ? { band: rel.relevance, demonstrates: rel.demonstrates, gaps: rel.gaps, rationale: rel.rationale } : null };
  }).sort((a, b) => rank(a.relevance?.band) - rank(b.relevance?.band));
}

// The market-demand overlay — computed skill demand from graded jobs in the band. Grounds both
// the resume/portfolio coaching and the upskilling plan's 'build'/'learn' items.
export function marketOverlay(s: State) {
  if (s.catalog.jobs === 0)
    return { computed: false, note: "no market data yet — discover companies (gather 'find_companies') and pull boards (gather 'fetch_jobs'); until then coach on resume structure/clarity and don't fabricate demand." };
  if (s.catalog.jobs - s.catalog.ungraded_jobs === 0)
    return { computed: false, note: `${s.catalog.jobs} jobs but none graded — run grade_job (look scope:'worklist') so demand can be computed.` };
  const band = bandFor(s.assessed_level);
  const demand = DB.marketSkillDemand(band, 20);
  return {
    computed: true,
    basis: band ? `${demand.total_jobs} graded job(s) in your band (${band.join("/")})` : `${demand.total_jobs} graded job(s) (whole catalog — assess your level for a banded view)`,
    top_skills: demand.skills,
    note: "what the market asks for — the in-demand skills the user can't yet evidence are the gap to coach and to target with build/learn plan items.",
  };
}

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

// Prep steps the user hasn't done — so a prepped/opted-out user is never told to redo them.
const prepHint = (s: State) => {
  const steps: string[] = [];
  if (!s.dimensions.onboarded) steps.push("onboard");
  if (!s.dimensions.profiled) steps.push("assess your competency profile");
  else if (!s.dimensions.verified) steps.push("verify it in a competency interview");
  if (s.profile?.no_resume) steps.push("build a resume from your real experience");
  else if (!s.has_resume) steps.push("capture your resume");
  return steps.length ? steps.join(", ") : "sharpen your resume and portfolio against real demand";
};
const emptyCatalogNote = (s: State) =>
  s.catalog.companies === 0
    ? `no jobs yet — discover companies with gather({ step: 'find_companies' }), then pull boards with gather({ step: 'fetch_jobs' }). You can also ${prepHint(s)} now.`
    : `${s.catalog.companies} companies discovered but no jobs pulled — run gather({ step: 'fetch_jobs' })${s.catalog.unresolved > 0 ? ` (${s.catalog.unresolved} unresolved)` : ""}. You can also ${prepHint(s)} now.`;

// Open threads a fresh session should resume (the durability payoff): an unfinished interview,
// in-progress plan items, applications with a pending next action.
function openThreads(s: State): string[] {
  const t: string[] = [];
  if (s.open_interview) t.push(`an unfinished ${s.open_interview.type} interview (id ${s.open_interview.id}) — resume it with record_interview, then complete it.`);
  if ((s.plan.in_progress ?? 0) > 0) t.push(`${s.plan.in_progress} upskilling item(s) in progress — see look({ at: 'plan' }); mark progress with update_plan_progress.`);
  const nextActions = DB.getApplications().filter((a) => a.next_action && !["offer", "rejected", "withdrawn"].includes(a.status));
  if (nextActions.length) t.push(`${nextActions.length} application(s) with a pending next action — see look({ at: 'applications' }).`);
  return t;
}

export function registerTools(server: McpServer): void {
  // ── orient: the one state door (loop-aware + resume-first) ─────────────────
  server.registerTool("orient", {
    description:
      "Start EVERY session here. Where the user is in the readiness loop, the single next best action, and OPEN THREADS to resume (an unfinished interview, in-progress plan items) — because the whole journey persists in the DB and spans weeks/months, this is how a fresh session picks up where the last left off. detail: 'recommend' (default; + the skill to use now), 'raw' (bare state), 'resume' (full rehydration bundle: state + open threads + recent journal), 'dashboard' (fitness profile, market gap, upskilling plan, notes). Safe as the first call; no required args.",
    inputSchema: { detail: enumOf(["recommend", "raw", "resume", "dashboard"]).optional() },
  }, async (a) => {
    const detail = a.detail ?? "recommend";
    const s = readJourneyState();
    if (detail === "raw") return json({ ...s, pending_tools: pendingTools() });

    if (detail === "resume") {
      return json({
        state: s,
        open_threads: openThreads(s),
        recent_history: DB.getEvents(20),
        note: "rehydration bundle — resume open threads first, then continue the loop. The DB holds everything; nothing was lost between sessions.",
      });
    }

    const base: Record<string, unknown> = { server: "jobbot9000", state: s, open_threads: openThreads(s) };
    if (s.dimensions.has_applications) {
      const total = Object.values(s.pipeline).reduce((x, y) => x + y, 0);
      base.pipeline_summary = `${total} application(s): ${Object.entries(s.pipeline).map(([k, v]) => `${v} ${k}`).join(", ")}.`;
    }
    if (s.dimensions.has_outreach) {
      const total = Object.values(s.outreach).reduce((x, y) => x + y, 0);
      base.outreach_summary = `${total} outreach message(s): ${Object.entries(s.outreach).map(([k, v]) => `${v} ${k}`).join(", ")}. The user sends; jobbot never does. See look({ at: 'outreach' }).`;
    }

    if (detail === "recommend") {
      const conf = s.assessment?.confidence;
      base.recommended_skill = !s.dimensions.onboarded ? "coach — onboard (profile + desires) first"
        : s.open_interview ? `verify — resume the open ${s.open_interview.type} interview (record_interview), then complete it`
        : !s.dimensions.profiled ? "coach — assess the competency profile (skeptically; absence ≠ low level)"
        : !s.dimensions.verified ? "verify — run a competency interview to establish/verify the profile (this is also how no-portfolio candidates are assessed)"
        : s.catalog.jobs === 0 ? `job-search — ${prepHint(s)}; then gather('find_companies') + gather('fetch_jobs') to populate the market`
        : (s.plan.in_progress ?? 0) > 0 ? "upskill — work the in-progress plan items; closing them raises fitness and re-opens roles"
        : "job-search or application";
      base.loop_note = "the loop: profile⇅desires → match → interview (assess+verify+upskill) → plan (learn/resume/build) → apply → re-match. Closing gaps re-opens higher-band roles.";
      return json(base);
    }

    // dashboard
    const band = bandFor(s.assessed_level);
    let gap: Record<string, unknown> = { note: "assess the competency profile to compute the relevant band" };
    if (band) {
      const relevant = (DB.db.prepare(
        `SELECT count(*) c FROM jobs WHERE still_live=1 AND grade_seniority IN (${band.map(() => "?").join(",")})`,
      ).get(...band) as { c: number }).c;
      gap = { relevant_in_band: relevant, whole_market: s.catalog.jobs, ungraded: s.catalog.ungraded_jobs, band };
      if (s.catalog.jobs === 0) gap.note = "zeros reflect an unpopulated catalog, not measured demand";
      else if (s.catalog.ungraded_jobs > 0) gap.note = `${s.catalog.ungraded_jobs} jobs ungraded — grade them before reading the band count as final`;
    }
    const notes: string[] = [];
    if (s.catalog.jobs === 0) notes.push(emptyCatalogNote(s));
    if (s.profile?.no_resume || s.profile?.no_github) notes.push("the user opted out of a resume/GitHub — the interview is the primary evidence; assess from it, don't penalize absence.");
    if (s.dimensions.portfolio_fetched && !s.dimensions.portfolio_graded) notes.push("portfolio fetched but ungraded — score each project's relevance with grade_portfolio_project.");
    // Assessment integrity — the profile, its confidence, and whether it's verified.
    if (s.dimensions.profiled) {
      base.competency_profile = s.competency;
      base.assessment = s.assessment;
      if (!s.dimensions.verified) notes.push(`profile band '${s.assessed_level}' is UNVERIFIED (no interview) — confidence is capped low. Run a competency interview to establish it; treat the floor '${s.assessment?.floor}' as the honest read until then.`);
    } else {
      notes.push("no competency profile yet — assess_competency per dimension (then verify in an interview).");
    }
    if (Object.keys(s.plan).length) base.upskilling_plan = s.plan;
    base.market_readiness_gap = gap;
    base.market_demand = marketOverlay(s);
    base.notes = notes;
    base.summary_note = "the honest read is yours to deliver — this surfaces the numbers.";
    return json(base);
  });

  // ── look: the one read door (never fetches, never writes) ──────────────────
  server.registerTool("look", {
    description:
      `The one read door — never fetches, never writes, safe in any order. at='jobs' lists by scope: 'market' (whole catalog), 'relevant' (your band ±1 with role fit; levels ${ladder}), 'worklist' (the grading queue). Filters apply to all scopes: titles_any (string[] OR-match title), location (substring), remote (true), query (title/company), grading_status. at='companies'. at='resume' (with_market_overlay adds computed demand; revision history is in at='history'). at='portfolio' (ranked by relevance + verification signals + overlay). at='profile' (identity + desires). at='competency' (the multi-dimensional profile + derived band + gaps — the assessment). at='interview' (latest session, or interview_id; its Q/A/exemplars/deltas). at='plan' (the upskilling plan by status). at='packet' (needs job_id: job+grade+skills+resume+role_fit+ranked portfolio+letter+application+honesty gating). at='applications' (the funnel). at='outreach' (drafted warm-outreach messages by status — draft/sent). at='history' (the journal timeline — what happened, when). Returns JSON to interpret.`,
    inputSchema: {
      at: enumOf(["jobs", "companies", "resume", "portfolio", "profile", "competency", "interview", "plan", "packet", "applications", "outreach", "history"]),
      scope: enumOf(["relevant", "market", "worklist"]).optional(),
      query: z.string().optional(),
      titles_any: z.array(z.string()).optional(),
      location: z.string().optional(),
      remote: z.boolean().optional(),
      grading_status: enumOf(["ungraded", "graded", "any"]).optional(),
      job_id: z.number().int().optional(),
      interview_id: z.number().int().optional(),
      with_market_overlay: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    const s = readJourneyState();

    if (a.at === "companies") {
      const companies = DB.getCompanies(a.limit ?? 200).map((c) => ({ ...c, tags: c.tags ? c.tags.split(",").filter(Boolean) : [], ats_status: c.resolved ? "resolved" : "unresolved" }));
      const out: Record<string, unknown> = { companies };
      if (companies.length === 0) out.note = "no companies yet — run gather({ step: 'find_companies' }).";
      return json(out);
    }

    if (a.at === "profile") {
      if (!s.profile) return json({ note: "not onboarded — capture identity + desires via capture_profile." });
      return json({ profile: s.profile, note: s.profile.desires ? undefined : "no desires captured — capture_profile({ desires: {...} }) so matching can weigh what the user WANTS, not just what they can do." });
    }

    if (a.at === "resume") {
      const resume = DB.getMasterResume();
      if (!resume) {
        if (s.profile?.no_resume) return json({ opted_out: true, note: "The user opted out of a resume — coach from the interview + described experience. Build one anytime via set_resume." });
        return json({ note: "no resume yet — capture via capture_profile, or build one via set_resume." });
      }
      const out: Record<string, unknown> = { resume: resume.content, updated_at: resume.updated_at };
      if (a.with_market_overlay) out.market_overlay = marketOverlay(s);
      return json(out);
    }

    if (a.at === "portfolio") {
      const repos = DB.getPortfolio();
      if (repos.length === 0) {
        if (s.profile?.no_github) return json({ opted_out: true, note: "The user opted out of GitHub — no portfolio penalty; the interview is the evidence. Coach from projects they describe." });
        return json({ note: "no portfolio yet — run gather({ step: 'ingest_portfolio' }), or add described work via add_portfolio_project." });
      }
      const portfolio = rankedPortfolio();
      const ungraded = portfolio.filter((p) => !p.relevance).length;
      const withV = portfolio.filter((p) => (p as any).verify) as any[];
      const manual = portfolio.filter((p) => p.source === "manual");
      const verification = {
        competency_interview: s.dimensions.verified ? "on file" : "NONE — claims unverified",
        solo_projects: withV.filter((p) => p.verify.solo).length,
        max_stars: portfolio.reduce((m, p) => Math.max(m, (p as any).stars ?? 0), 0),
        self_applied_badges: withV.reduce((n, p) => n + (p.verify.self_applied_badges ?? 0), 0),
        claimed_no_repo: manual.length,
      };
      const out: Record<string, unknown> = { portfolio, verification, market_overlay: marketOverlay(s) };
      const notes: string[] = [];
      if (ungraded) notes.push(`${ungraded}/${portfolio.length} ungraded — score relevance to the target role with grade_portfolio_project.`);
      if (s.has_resume) notes.push("a resume flagship with no repo here can be added via add_portfolio_project, but as an UNVERIFIED claim — probe it in the interview before featuring.");
      if (!s.dimensions.verified && (manual.length || verification.solo_projects > 0)) notes.push("no competency interview yet — solo/claimed projects are unverified; verify ownership + understanding before treating them as senior evidence.");
      if (notes.length) out.note = notes.join(" ");
      return json(out);
    }

    if (a.at === "competency") {
      const profile = DB.getCompetencyProfile();
      const derived = DB.deriveBand(profile);
      const assessed = new Set(profile.map((p) => p.dimension));
      const missing = DIMENSION.filter((d) => !assessed.has(d));
      const out: Record<string, unknown> = { profile, band: DB.assessmentSummary() ?? derived, dimensions_missing: missing };
      const notes: string[] = [];
      if (profile.length === 0) notes.push("no competency profile yet — assess each dimension with assess_competency (skeptically; absence ≠ low level).");
      else if (missing.length) notes.push(`${missing.join(", ")} not yet assessed.`);
      if (profile.length && !s.dimensions.verified) notes.push("profile is UNVERIFIED — confidence is capped low until a competency interview demonstrates it. Run one (record_interview).");
      if (notes.length) out.note = notes.join(" ");
      return json(out);
    }

    if (a.at === "interview") {
      const iv = a.interview_id ? DB.getInterview(a.interview_id) : (DB.getOpenInterview() ?? DB.getInterviews()[0]);
      if (!iv) return json({ note: "no interviews yet — run a competency interview (record_interview) to assess + verify + learn the bar." });
      return json({ interview: iv, items: DB.getInterviewItems(iv.id), all_sessions: DB.getInterviews().map((x) => ({ id: x.id, type: x.type, status: x.status, job_id: x.job_id })) });
    }

    if (a.at === "plan") {
      const plan = DB.getPlan();
      const out: Record<string, unknown> = { plan, counts: DB.planCounts() };
      if (plan.length === 0) out.note = "no upskilling plan yet — after an interview/assessment, turn the gaps into items with recommend_upskilling (learn/resume/build, market-grounded).";
      else out.note = "mark progress with update_plan_progress; closing items raises fitness and re-opens higher-band roles (re-match).";
      return json(out);
    }

    if (a.at === "history") {
      return json({ history: DB.getEvents(a.limit ?? 50), note: "the journal — append-only, persists across sessions. The full timeline of the search." });
    }

    if (a.at === "packet") {
      if (a.job_id === undefined) return json({ ok: false, error: "look({ at: 'packet' }) needs a job_id." });
      const job = DB.getJob(a.job_id);
      if (!job) return noJob(a.job_id);
      const master_resume = DB.getMasterResume()?.content ?? null;
      const fit = DB.getRoleFit(a.job_id) ?? null;
      const saved = DB.getCoverLetter(a.job_id);
      const missing: string[] = [];
      if (!master_resume) missing.push("master_resume");
      if (!fit) missing.push("role_fit");
      if (job.grade_seniority == null) missing.push("job_grade");
      const conf = s.assessment?.confidence ?? null;
      const verified = s.dimensions.verified;
      const featuredUnverified = rankedPortfolio()
        .filter((p) => p.relevance?.band === "strong" && p.source === "manual"
          && !DB.getInterviews().some((iv) => DB.getInterviewItems(iv.id).some((it) => (it.claim ?? "").toLowerCase().includes(String(p.repo).toLowerCase()))))
        .map((p) => p.repo);
      const { raw_json, ...jobLean } = job;
      const honesty: string[] = [];
      if (!verified || (conf && conf !== "high")) honesty.push(`the assessment is ${conf ?? "unrecorded"}${verified ? "" : "/unverified"} — write to the floor (${s.assessment?.floor ?? "?"}); don't assert seniority the user hasn't demonstrated.`);
      if (featuredUnverified.length) honesty.push(`do NOT feature ${featuredUnverified.join(", ")} — graded 'strong' but unverified. Verify in an interview first or leave out.`);
      const slotBase = missing.length
        ? `write the cover letter, then record_cover_letter — generic/ungrounded without: ${missing.join(", ")}.`
        : saved ? "a letter is saved — refine only if the packet changed." : "write the cover letter, then record_cover_letter.";
      return json({
        job: { ...jobLean, description: compactDescription(raw_json) },
        job_skills: DB.getJobSkills(a.job_id), master_resume, role_fit: fit, portfolio: rankedPortfolio(),
        saved_cover_letter: saved, application: DB.getApplication(a.job_id) ?? null, missing,
        readiness: { assessment_confidence: conf, assessment_floor: s.assessment?.floor ?? null, competency_verified: verified, featured_unverified_projects: featuredUnverified },
        cover_letter_slot: honesty.length ? `${slotBase} HONESTY: ${honesty.join(" ")}` : slotBase,
      });
    }

    if (a.at === "applications") {
      const applications = DB.getApplications();
      const out: Record<string, unknown> = { pipeline: DB.applicationCounts(), applications };
      if (applications.length === 0) out.note = "no applications tracked yet — record one after the user applies.";
      return json(out);
    }

    if (a.at === "outreach") {
      const outreach = DB.getOutreach();
      const out: Record<string, unknown> = { counts: DB.outreachCounts(), outreach };
      if (outreach.length === 0) out.note = "no outreach drafted yet — for a target company, draft a warm 'problem + project' message with record_outreach (the user sends it; jobbot never does).";
      return json(out);
    }

    // a.at === "jobs"
    const scope = a.scope ?? "market";
    if (scope === "relevant") {
      const limit = a.limit ?? 25;
      if (s.catalog.jobs === 0) return json({ band: bandFor(s.assessed_level), jobs: [], catalog_empty: true, note: emptyCatalogNote(s) });
      const band = bandFor(s.assessed_level);
      if (!band) {
        const rows = DB.db.prepare("SELECT j.id, c.name AS company, j.title, j.grade_seniority FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.still_live=1 ORDER BY j.last_seen_at DESC LIMIT ?").all(limit);
        return json({ band: null, low_confidence: true, jobs: rows, note: "no competency profile yet — assess it for a real band." });
      }
      const flt = jobFilters(a);
      const rows = DB.db.prepare(
        `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.comp_min, j.comp_max, j.grade_seniority, j.grade_market_signal,
                f.band AS fit, f.desire_alignment, f.gaps_json AS fit_gaps_json
         FROM jobs j JOIN companies c ON c.id=j.company_id
         LEFT JOIN role_fit f ON f.job_id=j.id
         WHERE j.still_live=1 AND j.grade_seniority IN (${band.map(() => "?").join(",")})${flt.where.length ? " AND " + flt.where.join(" AND ") : ""}
         ORDER BY j.last_seen_at DESC LIMIT ?`,
      ).all(...band, ...flt.args, limit) as any[];
      const jobs = rows.map(({ fit_gaps_json, ...r }) => ({ ...r, fit_gaps: fit_gaps_json ? JSON.parse(fit_gaps_json) : null }));
      return json({ band, jobs, note: "fit (over/exact/under) + desire_alignment are your judgment via assess_role_fit — grade them to surface the real tension (fitness vs. desire). The user's desires are in look({ at: 'profile' })." });
    }

    if (scope === "worklist") {
      const flt = jobFilters(a);
      const where = ["j.still_live=1", "(j.grade_seniority IS NULL OR j.graded_at < j.fetched_at)", ...flt.where];
      const rows = DB.db.prepare(
        `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.raw_json, j.fetched_at, j.graded_at,
                CASE WHEN j.grade_seniority IS NULL THEN 'never_graded' ELSE 'stale' END AS reason
         FROM jobs j JOIN companies c ON c.id=j.company_id
         WHERE ${where.join(" AND ")} ORDER BY j.fetched_at ASC LIMIT ?`,
      ).all(...flt.args, a.limit ?? 25) as any[];
      const jobs = rows.map(({ raw_json, ...r }) => ({ ...r, description: compactDescription(raw_json) }));
      const out: Record<string, unknown> = { count: jobs.length, jobs };
      if (jobs.length === 0) out.note = s.catalog.jobs === 0 ? emptyCatalogNote(s) : "no ungraded jobs match.";
      return json(out);
    }

    // market
    const limit = a.limit ?? 100;
    const flt = jobFilters(a);
    const where = ["j.still_live=1", ...flt.where];
    if (a.grading_status === "ungraded") where.push("j.grade_seniority IS NULL");
    if (a.grading_status === "graded") where.push("j.grade_seniority IS NOT NULL");
    const whereSql = where.join(" AND ");
    const total = (DB.db.prepare(`SELECT count(*) c FROM jobs j JOIN companies c ON c.id=j.company_id WHERE ${whereSql}`).get(...flt.args) as { c: number }).c;
    const rows = DB.db.prepare(
      `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.comp_min, j.comp_max, j.grade_seniority
       FROM jobs j JOIN companies c ON c.id=j.company_id WHERE ${whereSql} ORDER BY j.last_seen_at DESC LIMIT ?`,
    ).all(...flt.args, limit);
    const out: Record<string, unknown> = { count: rows.length, total, jobs: rows };
    if (s.catalog.jobs === 0) out.note = emptyCatalogNote(s);
    else if (rows.length < total) out.note = `showing ${rows.length} of ${total} — raise limit or narrow with filters.`;
    return json(out);
  });

  // ── onboarding & profile (personal, mechanical) ────────────────────────────
  server.registerTool("capture_profile", {
    description: "Front door: capture identity, the resume, GitHub, the target work, and DESIRES (what the user WANTS — the other half of matching). Idempotent; partial is fine; desires merge (pass only what changed). Record 'no resume'/'no github' explicitly — absence is never penalized.",
    inputSchema: {
      resume: z.string().optional(), no_resume: z.boolean().optional(),
      github_handle: z.string().optional(), no_github: z.boolean().optional(),
      target_role: z.string().optional(), target_niche: z.string().optional(), location_pref: z.string().optional(),
      desires: z.object({
        role_types: z.array(z.string()).optional(),
        domains: z.array(z.string()).optional(),
        locations: z.array(z.string()).optional(),
        comp_floor: z.number().optional(),
        work_style: z.string().optional(),
        freetext: z.string().optional(),
        priorities: z.array(z.string()).optional(),
      }).optional(),
    },
  }, async (a) => {
    if (a.resume) DB.setMasterResume(a.resume);
    const patch: any = {};
    for (const k of ["target_role", "target_niche", "location_pref", "github_handle"] as const) if (a[k] !== undefined) patch[k] = a[k];
    if (a.no_resume !== undefined) patch.no_resume = a.no_resume ? 1 : 0;
    if (a.no_github !== undefined) patch.no_github = a.no_github ? 1 : 0;
    if (a.desires !== undefined) patch.desires = a.desires;
    DB.upsertProfile(patch);
    DB.logEvent("profile", "profile/desires updated");
    return json({ ok: true, state: readJourneyState() });
  });

  server.registerTool("set_resume", {
    description: `Set the master resume. → personal. Without a rationale it's the user's own wholesale edit, landing as-is. WITH a rationale it's a COACHED revision (Mode: resume_revision) — journaled to the history (look at:'history'). ALLOWED when revising: restructure, sharpen, quantify REAL impact, surface buried strengths, tailor to a role. BLOCKED: invent jobs/titles/dates/metrics or inflate scope (the no-invention guardrail) — route unbacked-but-strong claims to the competency interview instead. Read back via look({ at: 'resume' }).`,
    inputSchema: { content: z.string().min(1), rationale: z.string().optional() },
  }, async (a) => {
    DB.setMasterResume(a.content, a.rationale);
    const out: Record<string, unknown> = { ok: true, updated: DB.getMasterResume()?.updated_at };
    if (a.rationale) out.note = "coached revision journaled. Only real, defensible claims — anything unbacked belongs in the interview, not the resume.";
    return json(out);
  });

  server.registerTool("add_portfolio_project", {
    description: "Add a project ingest_portfolio can't see — a private/absent repo the user describes. → personal. With no public code there's nothing to inspect, so it's an UNVERIFIED CLAIM (could be someone else's product, a clone, or aspirational): added as 'claimed', and must NOT be featured as strong until a competency interview confirms ownership + understanding. A missing flagship lowers confidence; it doesn't auto-promote.",
    inputSchema: { name: z.string(), description: z.string().min(1), languages: z.array(z.string()).optional(), url: z.string().optional() },
  }, async (a) => {
    DB.addPortfolioProject(a.name, { repo: a.name, name: a.name, description: a.description, languages: a.languages ?? [], url: a.url ?? null, source: "manual", provenance: "claimed" });
    return json({ ok: true, repo: a.name, provenance: "claimed", note: "added as an UNVERIFIED claim — probe ownership + understanding in a competency interview before grading 'strong' or featuring it." });
  });

  // ── competency profile (judgment, mode-governed) ───────────────────────────
  server.registerTool("assess_competency", {
    description: `Assess ONE competency dimension (${DIMENSION.join(" | ")}) on the ladder ${ladder}. → personal. The keystone, multi-dimensional and SKEPTICAL: a resume/portfolio is a CLAIM (tag evidence with provenance ${PROVENANCE.join(" | ")}). CRITICAL: absence of public evidence is NOT weakness — set confidence low and let the interview establish the level; do NOT default the level down for a missing portfolio. confidence='high' needs demonstrated/corroborated evidence (an interview). Call once per dimension; the overall band is derived. Mode: competency_profile.`,
    inputSchema: {
      dimension: enumOf(DIMENSION),
      level: enumOf(SENIORITY),
      confidence: enumOf(CONFIDENCE),
      evidence: z.array(z.object({ claim: z.string(), provenance: enumOf(PROVENANCE), verified: z.boolean().optional() })).optional(),
      rationale: z.string().min(1),
    },
  }, async (a) => {
    DB.setCompetency(a.dimension, a.level, a.confidence, a.evidence ?? [], a.rationale);
    const out: Record<string, unknown> = { ok: true, dimension: a.dimension, level: a.level, confidence: a.confidence, derived_band: DB.deriveBand() };
    const s = readJourneyState();
    if (a.confidence === "high" && !s.dimensions.verified) out.note = "confidence='high' without a competency interview on file — high confidence needs demonstrated/corroborated evidence. Run record_interview or lower confidence.";
    const ev = a.evidence ?? [];
    if (ev.length && ev.every((e) => e.provenance === "claimed" || e.provenance === "self_published") && !s.dimensions.verified)
      out.note = "all evidence is claimed/self-published (unverified) — fine to set the level low-confidence, but verify in an interview before trusting it. Absence of proof ≠ low ability; don't over- OR under-rate.";
    return json(out);
  });

  // ── interview (the engine: assess + verify + upskill; repeatable, resumable) ─
  server.registerTool("record_interview", {
    description: `Record a competency or role-fit interview — the engine that ASSESSES (primary evidence for no-portfolio candidates), VERIFIES (catches over-claiming), and UPSKILLS (each item carries a grounded exemplar — 'what a great candidate would have said' — and the delta). → personal. type: ${INTERVIEW_TYPE.join(" | ")} (role_fit needs job_id; its exemplars are anchored to that posting's bar). Resumable: appends to the open interview of this type, or starts one. Set done:true (with a summary) to complete it; verified_ceiling caps/establishes the level. Mode: interview. After completing, re-run assess_competency with the now-demonstrated evidence and turn deltas into plan items (recommend_upskilling).`,
    inputSchema: {
      type: enumOf(INTERVIEW_TYPE),
      job_id: z.number().int().optional(),
      items: z.array(z.object({
        dimension: enumOf(DIMENSION).optional(),
        claim: z.string().optional(),
        question: z.string(),
        answer_summary: z.string().optional(),
        exemplar: z.string().optional(),
        score: enumOf(SCORE).optional(),
        ownership: enumOf(OWNERSHIP).optional(),
        understanding: enumOf(UNDERSTANDING).optional(),
        delta_notes: z.string().optional(),
      })).min(1),
      verified_ceiling: enumOf(SENIORITY).optional(),
      summary: z.string().optional(),
      done: z.boolean().optional(),
    },
  }, async (a) => {
    if (a.type === "role_fit" && a.job_id !== undefined && !DB.getJob(a.job_id)) return noJob(a.job_id);
    const open = DB.getOpenInterview();
    const id = open && open.type === a.type && (open.job_id ?? null) === (a.job_id ?? null) ? open.id : DB.startInterview(a.type, a.job_id);
    DB.addInterviewItems(id, a.items);
    const out: Record<string, unknown> = { ok: true, interview_id: id, items_recorded: a.items.length };
    if (a.done) {
      if (!a.summary) return json({ ok: false, error: "completing an interview (done:true) needs a summary — the honest read after questioning." });
      DB.completeInterview(id, a.verified_ceiling ?? null, a.summary);
      const weak = a.items.filter((i) => i.score === "weak" || i.understanding === "shallow" || i.understanding === "cannot_explain" || i.ownership === "observer").length;
      out.completed = true;
      out.note = `completed. ${weak}/${a.items.length} item(s) were weak/unverified. Now: re-run assess_competency per dimension with the demonstrated evidence (level ≤ verified_ceiling ${a.verified_ceiling ?? "?"}), and recommend_upskilling for each delta.`;
    } else {
      out.note = "appended. Continue the interview, or call again with done:true + a summary to complete it (the session persists, so you can resume it in a later turn).";
    }
    return json(out);
  });

  // ── job grade (catalog) ─────────────────────────────────────────────────────
  server.registerTool("grade_job", {
    description: `A job's intrinsic grade: seniority (${ladder}), market signal (${MARKET.join(" | ")}), required-vs-preferred skills. → catalog. Mode: job_intrinsic.`,
    inputSchema: { job_id: z.number().int(), seniority: enumOf(SENIORITY), market_signal: enumOf(MARKET), skills: z.array(z.object({ skill: z.string(), kind: enumOf(["required", "preferred"]) })) },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    DB.setJobGrade(a.job_id, a.seniority, a.market_signal, a.skills);
    return json({ ok: true, job_id: a.job_id });
  });

  // ── role fit (judgment, per-dimension + desire alignment) ──────────────────
  server.registerTool("assess_role_fit", {
    description: `The user's fit on a job: band (${FITBAND.join(" | ")}) PER DIMENSION + desire_alignment (${DESIRE_ALIGN.join(" | ")}) vs. their stated desires. → personal. This is the hermeneutic join: surface the tension (fitness vs. desire — e.g. 'a fit but onsite when you want remote', or 'you want it but you're a level under'). Mode: role_fit. Requires a competency profile.`,
    inputSchema: {
      job_id: z.number().int(),
      band: enumOf(FITBAND),
      dim_deltas: z.object({ technical_depth: z.string().optional(), system_design: z.string().optional(), communication: z.string().optional(), ownership: z.string().optional() }).optional(),
      desire_alignment: enumOf(DESIRE_ALIGN),
      gaps: z.array(z.string()).optional(),
      rationale: z.string().min(1),
    },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    if (!readJourneyState().dimensions.profiled) return json({ ok: false, error: "assess the competency profile first (assess_competency) — role fit is measured against it." });
    DB.setRoleFit(a.job_id, a.band, a.dim_deltas ?? null, a.desire_alignment, a.gaps ?? [], a.rationale);
    return json({ ok: true, job_id: a.job_id, band: a.band, desire_alignment: a.desire_alignment });
  });

  // ── portfolio relevance (judgment) ─────────────────────────────────────────
  server.registerTool("grade_portfolio_project", {
    description: `A portfolio project's relevance to the TARGET ROLE (${RELEVANCE.join(" | ")}). → personal. Grounds which projects to feature/anchor/deep-dive. Mode: portfolio_relevance. repo = full_name from look({ at: 'portfolio' }).`,
    inputSchema: { repo: z.string(), relevance: enumOf(RELEVANCE), demonstrates: z.array(z.string()), gaps: z.array(z.string()).optional(), rationale: z.string().min(1) },
  }, async (a) => {
    const proj = DB.getPortfolio().find((p) => p.repo === a.repo);
    if (!proj) return json({ ok: false, error: `no repo '${a.repo}' — list via look({ at: 'portfolio' }).` });
    const out: Record<string, unknown> = { ok: true, repo: a.repo, relevance: a.relevance };
    const notes: string[] = [];
    if (!readJourneyState().profile?.target_role) notes.push("no target_role on file — capture it via capture_profile so the judgment is anchored.");
    const verifiedInInterview = DB.getInterviews().some((iv) => DB.getInterviewItems(iv.id).some((it) => (it.claim ?? "").toLowerCase().includes(a.repo.toLowerCase())));
    if (a.relevance === "strong" && !verifiedInInterview) {
      if (proj.source === "manual") notes.push(`'${a.repo}' is a manual/claimed project with no public code and no interview finding — grading it 'strong' features an UNVERIFIED claim. Verify in an interview first, or grade lower.`);
      else {
        const v = proj.facts_json ? (JSON.parse(proj.facts_json).verify ?? null) : null;
        if (v && v.solo === true && v.authored_share != null && v.authored_share < 0.5) notes.push(`'${a.repo}' shows low authored_share (${v.authored_share}) — confirm it's the user's work before featuring 'strong'.`);
      }
    }
    if (notes.length) out.note = notes.join(" ");
    DB.setPortfolioRelevance(a.repo, a.relevance, a.demonstrates, a.gaps ?? [], a.rationale);
    return json(out);
  });

  // ── upskilling plan (judgment) ─────────────────────────────────────────────
  server.registerTool("recommend_upskilling", {
    description: `Turn assessed gaps into a tracked plan that raises REAL fitness. → personal. Mode: upskilling_plan. Each item: gap (a dimension or skill), type (${PLAN_TYPE.join(" | ")}), spec (concrete — 'learn' = what to do, 'resume' = a specific honest change, 'build' = a project to ship), market_demand (which in-demand skill it closes — ground 'build'/'learn' in the market overlay). Tracked suggested→in_progress→done; closing items re-opens higher-band roles.`,
    inputSchema: { items: z.array(z.object({ gap: z.string(), type: enumOf(PLAN_TYPE), spec: z.string().min(1), market_demand: z.string().optional() })).min(1) },
  }, async (a) => {
    const ids = a.items.map((it) => DB.addPlanItem(it.gap, it.type, it.spec, it.market_demand));
    return json({ ok: true, added: ids.length, item_ids: ids, note: "tracked. Mark progress with update_plan_progress; when items close, re-match (look jobs scope:'relevant') — the band may have moved." });
  });

  server.registerTool("update_plan_progress", {
    description: `Update an upskilling-plan item's status (${PLAN_STATUS.join(" | ")}) and/or notes. → personal, mechanical. Marking items 'done' raises fitness — re-assess the relevant dimension (assess_competency) and re-match. Find item ids via look({ at: 'plan' }).`,
    inputSchema: { item_id: z.number().int(), status: enumOf(PLAN_STATUS).optional(), progress_notes: z.string().optional() },
  }, async (a) => {
    if (!DB.updatePlanItem(a.item_id, a.status ?? null, a.progress_notes ?? null)) return json({ ok: false, error: `no plan item ${a.item_id} — list via look({ at: 'plan' }).` });
    const out: Record<string, unknown> = { ok: true, item_id: a.item_id, plan: DB.planCounts() };
    if (a.status === "done") out.note = "closed — re-assess the dimension it addressed (assess_competency) and re-run look({ at: 'jobs', scope: 'relevant' }); a higher band may now be in reach.";
    return json(out);
  });

  // ── cover letter (judgment) ────────────────────────────────────────────────
  server.registerTool("record_cover_letter", {
    description: "Persist the cover letter + talking points for a role. → personal. Mode: cover_letter — lead with a real angle, no invented experience. Gated on the verified assessment: write to the floor, don't assert seniority the user hasn't demonstrated. Read back via look({ at: 'packet' }).",
    inputSchema: { job_id: z.number().int(), content: z.string().min(1), talking_points: z.array(z.string()).optional() },
  }, async (a) => {
    const job = DB.getJob(a.job_id);
    if (!job) return noJob(a.job_id);
    DB.recordCoverLetter(a.job_id, a.content, a.talking_points ?? []);
    const missing: string[] = [];
    if (!DB.getMasterResume()?.content) missing.push("master_resume");
    if (!DB.getRoleFit(a.job_id)) missing.push("role_fit");
    if (job.grade_seniority == null) missing.push("job_grade");
    const s = readJourneyState();
    const notes: string[] = [];
    if (missing.length) notes.push(`missing ${missing.join(", ")} — the letter may be ungrounded; don't fabricate.`);
    if (!s.dimensions.verified || (s.assessment?.confidence && s.assessment.confidence !== "high")) notes.push(`the assessment is ${s.assessment?.confidence ?? "unrecorded"}${s.dimensions.verified ? "" : "/unverified"} — claim only what's demonstrated (write to floor ${s.assessment?.floor ?? "?"}).`);
    const out: Record<string, unknown> = { ok: true, job_id: a.job_id, next: "when the user applies, track it with record_application." };
    if (notes.length) out.note = "saved — " + notes.join(" ");
    return json(out);
  });

  // ── application tracking (personal, mechanical) ────────────────────────────
  server.registerTool("record_application", {
    description: `Track the user's application (they apply; this records it). → personal. status: ${APP_STATUS.join(" | ")}. Idempotent; a status update preserves fields you don't pass. Optional applied_at / next_action / next_action_at / notes. Read the funnel via look({ at: 'applications' }).`,
    inputSchema: { job_id: z.number().int(), status: enumOf(APP_STATUS), applied_at: z.string().optional(), next_action: z.string().optional(), next_action_at: z.string().optional(), notes: z.string().optional() },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    DB.recordApplication(a.job_id, { status: a.status, applied_at: a.applied_at, next_action: a.next_action, next_action_at: a.next_action_at, notes: a.notes });
    return json({ ok: true, job_id: a.job_id, status: a.status, pipeline: DB.applicationCounts() });
  });

  // ── outreach (personal, mode-governed) — DRAFT-ONLY warm messages ──────────
  server.registerTool("record_outreach", {
    description: `Draft a WARM outreach message to a person at a target company — DRAFT ONLY; jobbot NEVER sends, the user sends it themselves. → personal. Mode: outreach (lead with a specific problem/initiative at the company you can help with + ONE project from the graded portfolio as evidence; customized, grounded, ${MODE.outreach.constraints.no_invented_experience ? "no invented experience" : "stay grounded"}). Needs company_id (from look({ at: 'companies' })); contact_name/role/url, job_id, angle, anchor_repo optional. Pass outreach_id to revise a draft or mark it status:'sent' after the user sends. Read drafts via look({ at: 'outreach' }).`,
    inputSchema: {
      company_id: z.number().int(),
      message: z.string().min(1).optional(), // required for a new draft; optional when updating (outreach_id) e.g. to mark sent
      contact_name: z.string().optional(),
      contact_role: z.string().optional(),
      contact_url: z.string().optional(),
      job_id: z.number().int().optional(),
      angle: z.string().optional(),
      anchor_repo: z.string().optional(),
      status: enumOf(["draft", "sent"]).optional(),
      outreach_id: z.number().int().optional(),
    },
  }, async (a) => {
    if (a.outreach_id === undefined && !a.message) return json({ ok: false, error: "message is required to draft new outreach (it's the message body). Pass outreach_id to update an existing draft." });
    const company = DB.db.prepare("SELECT name FROM companies WHERE id=?").get(a.company_id) as { name: string } | undefined;
    if (!company) return json({ ok: false, error: `no company ${a.company_id} — list companies via look({ at: 'companies' }).` });
    if (a.job_id !== undefined && !DB.getJob(a.job_id)) return noJob(a.job_id);
    const id = DB.recordOutreach(a.outreach_id, {
      company_id: a.company_id, message: a.message, job_id: a.job_id, contact_name: a.contact_name,
      contact_role: a.contact_role, contact_url: a.contact_url, angle: a.angle, anchor_repo: a.anchor_repo, status: a.status,
    });
    const out: Record<string, unknown> = { ok: true, outreach_id: id, company: company.name, status: a.status ?? "draft", outreach: DB.outreachCounts() };
    if (a.anchor_repo && !DB.getPortfolio().some((p) => p.repo === a.anchor_repo))
      out.note = `anchor_repo '${a.anchor_repo}' isn't in the portfolio — feature a real project (look at:'portfolio'); don't cite work that isn't there.`;
    else out.next = "draft saved — the USER sends it (jobbot never does). After they send, call again with this outreach_id and status:'sent'.";
    return json(out);
  });

  // ── gather: the one door to the outside world (sync cut in v2) ─────────────
  server.registerTool("gather", {
    description:
      "The one door to the outside world — reach out, persist, return findings. step: " +
      "'find_companies' (lead-gen → ATS-slug resolution; FREE. Pass companies:[{name,domain}] to resolve on demand, or companies:[{name,ats_platform,ats_slug}] to PIN a board; or a query from the resume for the curated roster; provider:'theirstack' (+THEIRSTACK_API_KEY) for paid targeted discovery, count-first + credit-gated), " +
      "'fetch_jobs' (pull live ATS boards → raw ungraded jobs; keyless. ats_platform+ats_slug or company_id, or none = refresh all resolved, stalest-first), " +
      "'ingest_portfolio' (public GitHub repos → portfolio facts + VERIFICATION signals (authorship/traction/age/vanity-badges); keyless. github_handle or the profile's; enrich_max bounds enrichment). " +
      "Persistence is a side effect; the agent still never writes the DB itself.",
    inputSchema: {
      step: enumOf(["find_companies", "fetch_jobs", "ingest_portfolio"]),
      companies: z.array(z.object({ name: z.string(), domain: z.string().optional(), ats_platform: enumOf(["ashby", "greenhouse", "lever", "workable"]).optional(), ats_slug: z.string().optional() })).optional(),
      titles: z.array(z.string()).optional(), technologies: z.array(z.string()).optional(),
      seniority: enumOf(["junior", "mid_level", "senior", "staff", "c_level"]).optional(),
      locations: z.array(z.string()).optional(), posted_within_days: z.number().int().positive().optional(),
      provider: z.string().optional(), max_credits: z.number().int().positive().optional(), confirm: z.boolean().optional(), niche: z.string().optional(),
      ats_platform: enumOf(["ashby", "greenhouse", "lever", "workable"]).optional(), ats_slug: z.string().optional(), company_id: z.number().int().optional(),
      github_handle: z.string().optional(), include_forks: z.boolean().optional(), enrich_max: z.number().int().nonnegative().optional(),
      dry_run: z.boolean().optional(), limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    switch (a.step) {
      case "find_companies": return findCompanies(a);
      case "fetch_jobs": return fetchJobs(a);
      case "ingest_portfolio": return ingestPortfolio(a);
      default: return json({ ok: false, error: `unknown gather step '${a.step}'` });
    }
  });
}

// ── find_companies orchestration ─────────────────────────────────────────────
interface FindArgs {
  titles?: string[]; technologies?: string[]; seniority?: string; locations?: string[]; posted_within_days?: number;
  companies?: { name: string; domain?: string; ats_platform?: string; ats_slug?: string }[];
  provider?: string; max_credits?: number; confirm?: boolean; dry_run?: boolean; limit?: number;
}
interface FindDeps { ctx?: ProviderContext; resolve?: typeof resolveAts }

async function persistDiscovered(companies: DiscoveredCompany[], resolve: typeof resolveAts) {
  let inserted = 0, resolved = 0, unresolved = 0, skipped = 0;
  for (const c of companies) {
    if (c.ats_platform && c.ats_slug) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags, ats_platform: c.ats_platform, ats_slug: c.ats_slug });
      if (up.inserted) inserted++; resolved++; continue;
    }
    const hit = await resolve({ name: c.name, domain: c.domain });
    if (hit) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags, ats_platform: hit.platform, ats_slug: hit.slug });
      if (up.inserted) inserted++; resolved++;
    } else if (c.domain) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags });
      if (up.inserted) inserted++; DB.bumpResolveAttempt(up.id); unresolved++;
    } else skipped++;
  }
  return { inserted, resolved, unresolved, skipped };
}

const nextNote = () => "resolved companies are ready — pull their live boards with gather({ step: 'fetch_jobs' }).";

export async function findCompanies(a: FindArgs, deps: FindDeps = {}) {
  const resolve = deps.resolve ?? resolveAts;
  if (a.companies?.length) {
    const discovered: DiscoveredCompany[] = a.companies.map((c) => ({
      name: c.name, domain: c.domain ?? null, tags: [], source: "manual",
      ats_platform: (c.ats_platform && c.ats_slug) ? c.ats_platform : null,
      ats_slug: (c.ats_platform && c.ats_slug) ? c.ats_slug : null,
    }));
    const persisted = await persistDiscovered(discovered, resolve);
    const pinned = a.companies.filter((c) => c.ats_platform && c.ats_slug).length;
    const out: Record<string, unknown> = { ok: true, mode: "on_demand", credits_spent: 0, discovered: discovered.length, persisted, catalog: readJourneyState().catalog, next: nextNote() };
    if (pinned) out.note = `${pinned} board(s) pinned (slug-complete; gather('fetch_jobs') confirms them).`;
    return json(out);
  }
  const providerName = a.provider ?? Object.keys(PROVIDERS)[0];
  const provider = PROVIDERS[providerName];
  if (!provider) return json({ ok: false, error: `unknown provider '${providerName}' — available: ${Object.keys(PROVIDERS).join(", ")}` });
  const ctx = deps.ctx ?? providerContext();
  if (!provider.available(ctx)) return json({ ok: false, error: `provider '${provider.name}' is unavailable${provider.requiresKey ? " — set THEIRSTACK_API_KEY to opt into paid targeting. The free 'curated' provider and the 'companies' on-demand path need no key." : "."}` });
  const q: DiscoverQuery = { titles: a.titles, technologies: a.technologies, seniority: a.seniority ?? null, locations: a.locations, posted_within_days: a.posted_within_days, limit: a.limit };
  let est; try { est = await provider.estimate(q, ctx); } catch (e) { return json({ ok: false, error: `discovery pre-flight failed: ${errMsg(e)}` }); }
  const ceiling = a.max_credits ?? MAX_CREDITS_PER_RUN;
  if (a.dry_run) return json({ ok: true, dry_run: true, provider: provider.name, estimate: est, ceiling, note: est.projected_credits === 0 ? "free provider — re-run without dry_run to persist." : "free count only — re-run without dry_run to pull (paid)." });
  if (est.projected_credits > ceiling && !a.confirm) return json({ ok: false, confirmation_required: true, provider: provider.name, estimate: est, ceiling, note: `projected ~${est.projected_credits} credits exceeds the ceiling (${ceiling}). Re-run with confirm:true, or lower limit / raise max_credits.` });
  let result; try { result = await provider.discover(q, ctx); } catch (e) { return json({ ok: false, error: `discovery failed: ${errMsg(e)}` }); }
  const persisted = await persistDiscovered(result.companies, resolve);
  const out: Record<string, unknown> = { ok: true, provider: provider.name, estimate: est, credits_spent: result.records_billed, discovered: result.companies.length, persisted, catalog: readJourneyState().catalog, next: nextNote() };
  if (result.companies.length === 0 && provider.name === "curated") out.note = "the curated seed roster is empty. Name companies directly — gather({ step: 'find_companies', companies: [{ name, domain }] }) — or add to seeds/companies.json, or set THEIRSTACK_API_KEY.";
  return json(out);
}

// ── fetch_jobs orchestration ──────────────────────────────────────────────────
interface FetchArgs { ats_platform?: string; ats_slug?: string; company_id?: number; limit?: number }
interface FetchTarget { company_id: number; platform: AtsPlatform; slug: string; name: string }
interface FetchDeps { fetchBoardFn?: typeof fetchBoard; sleep?: (ms: number) => Promise<void>; politeDelayMs?: number }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchJobs(a: FetchArgs, deps: FetchDeps = {}) {
  const fetchBoardFn = deps.fetchBoardFn ?? fetchBoard;
  const sleep = deps.sleep ?? realSleep;
  const politeDelayMs = deps.politeDelayMs ?? 1000;
  const targets: FetchTarget[] = [];
  if (a.ats_platform && a.ats_slug) {
    const platform = a.ats_platform as AtsPlatform;
    const existing = DB.getCompanyByAts(platform, a.ats_slug);
    const id = existing?.id ?? DB.upsertCompany({ name: a.ats_slug, ats_platform: platform, ats_slug: a.ats_slug, source: "manual" }).id;
    targets.push({ company_id: id, platform, slug: a.ats_slug, name: existing?.name ?? a.ats_slug });
  } else if (a.company_id !== undefined) {
    const c = DB.db.prepare("SELECT id, name, ats_platform, ats_slug FROM companies WHERE id=?").get(a.company_id) as { id: number; name: string; ats_platform: string | null; ats_slug: string | null } | undefined;
    if (!c) return json({ ok: false, error: `no company ${a.company_id}.` });
    if (!c.ats_platform || !c.ats_slug) return json({ ok: false, error: `company ${a.company_id} (${c.name}) has no ATS slug — resolve via gather('find_companies') first.` });
    targets.push({ company_id: c.id, platform: c.ats_platform as AtsPlatform, slug: c.ats_slug, name: c.name });
  } else {
    for (const c of DB.getResolvedCompanies(a.limit ?? 25)) targets.push({ company_id: c.id, platform: c.ats_platform as AtsPlatform, slug: c.ats_slug!, name: c.name });
  }
  if (targets.length === 0) return json({ ok: true, boards_fetched: 0, note: "no resolved companies — discover some via gather('find_companies'), or target a board with ats_platform + ats_slug." });

  const totals = { inserted: 0, updated: 0, closed: 0 };
  const per_company: Record<string, unknown>[] = [];
  let unreachable = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (i > 0 && politeDelayMs > 0) await sleep(politeDelayMs);
    let board; try { board = await fetchBoardFn(t.platform, t.slug); } catch { board = null; }
    if (board === null) { unreachable++; per_company.push({ company_id: t.company_id, name: t.name, platform: t.platform, slug: t.slug, unreachable: true }); continue; }
    const r = DB.upsertJobs(t.company_id, board);
    totals.inserted += r.inserted; totals.updated += r.updated; totals.closed += r.closed;
    per_company.push({ company_id: t.company_id, name: t.name, platform: t.platform, slug: t.slug, ...r });
  }
  return json({
    ok: true, boards_fetched: targets.length - unreachable, unreachable, jobs: totals, per_company, catalog: readJourneyState().catalog,
    next: totals.inserted + totals.updated > 0 ? "grade the new jobs — look({ at: 'jobs', scope: 'worklist' }), then grade_job." : "no live postings found (or all unreachable).",
  });
}

// ── ingest_portfolio orchestration (with verification signals) ────────────────
const ENRICH_MAX_DEFAULT = 20;
interface IngestArgs { github_handle?: string; include_forks?: boolean; enrich_max?: number }
interface IngestDeps { fetchReposFn?: typeof fetchUserRepos; enrichFn?: typeof enrichRepo; token?: string }

export async function ingestPortfolio(a: IngestArgs, deps: IngestDeps = {}) {
  const s = readJourneyState();
  if (s.profile?.no_github) return json({ ok: false, error: "the user opted out of GitHub (no_github) — coach from the interview + described projects; absence is not penalized." });
  const handle = a.github_handle ?? s.profile?.github_handle ?? undefined;
  if (!handle) return json({ ok: false, error: "no github_handle — pass one, or capture it via capture_profile." });
  const token = deps.token ?? process.env.GITHUB_TOKEN;
  const fetchReposFn = deps.fetchReposFn ?? fetchUserRepos;
  let repos: RepoFacts[];
  try { repos = await fetchReposFn(handle, { token }); } catch (e) { return json({ ok: false, error: `GitHub fetch failed: ${errMsg(e)}` }); }
  const kept = a.include_forks ? repos : repos.filter((r) => !r.is_fork);
  const enrichFn = deps.enrichFn ?? enrichRepo;
  const enrichMax = a.enrich_max ?? ENRICH_MAX_DEFAULT;
  const toEnrich = kept.slice(0, enrichMax);
  for (const r of toEnrich) {
    const e = await enrichFn(r.repo, { token, handle });
    r.languages = e.languages; r.readme_excerpt = e.readme_excerpt; r.verify = e.verify;
  }
  DB.replacePortfolio(kept.map((r) => ({ repo: r.repo, facts: r })));
  if (a.github_handle && a.github_handle !== s.profile?.github_handle) DB.upsertProfile({ github_handle: a.github_handle });
  const verified = toEnrich.filter((r) => r.verify);
  const max_stars = kept.reduce((m, r) => Math.max(m, r.stars), 0);
  const verification = {
    enriched_with_signals: verified.length,
    solo_projects: verified.filter((r) => r.verify!.solo).length,
    low_traction: kept.filter((r) => r.stars < 2 && r.forks < 2).length,
    self_applied_badges: verified.reduce((n, r) => n + r.verify!.self_applied_badges, 0),
    max_stars,
    not_sole_author: verified.filter((r) => r.verify!.authored_share != null && r.verify!.authored_share < 0.5).length,
  };
  return json({
    ok: true, github_handle: handle, fetched: repos.length, kept: kept.length, enriched: toEnrich.length,
    forks_skipped: a.include_forks ? 0 : repos.length - kept.length,
    top_by_recent: kept.slice(0, 5).map((r) => ({ repo: r.repo, languages: r.languages ?? (r.language ? [r.language] : []), stars: r.stars, pushed_at: r.pushed_at, solo: r.verify?.solo ?? null })),
    verification, portfolio_count: DB.counts().portfolio,
    next: kept.length === 0
      ? "no public repos found (or all forks). Coach from the interview + described projects — no portfolio penalty."
      : `read look({ at: 'portfolio' }) — but VERIFY before grading: mostly-solo, low-traction repos (max_stars=${max_stars}) are UNVERIFIED until a competency interview confirms the user built and understands them. Assess skeptically; claimed ≠ demonstrated.${toEnrich.length < kept.length ? ` (${kept.length - toEnrich.length} beyond enrich_max kept at basic facts.)` : ""}`,
  });
}
