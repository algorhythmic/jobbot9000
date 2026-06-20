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

type State = ReturnType<typeof readJourneyState>;

// Capability flags — flip these on as the external integrations land, and replace
// the matching gather() step's planned() with the real persister. They keep every
// tool honest about what isn't available yet instead of pointing at inert stubs.
// WHEN YOU ENABLE DISCOVERY (or any flag): also update the "Availability"/"Next"
// notes in the three skills (skills/{coach,job-search,application}/SKILL.md). The
// runtime self-corrects (pending_tools drops the step), but the skill prose — which
// says discovery is "next/pending" — does not, so refresh it to match.
const DISCOVERY_AVAILABLE = false;        // gather: find_companies / fetch_jobs
const PORTFOLIO_INGEST_AVAILABLE = false; // gather: ingest_portfolio
const SYNC_AVAILABLE = false;             // gather: sync_catalog
const pendingSteps = (): string[] => [
  ...(!DISCOVERY_AVAILABLE ? ["find_companies", "fetch_jobs"] : []),
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
const emptyCatalogNote = (s: State) =>
  `the job catalog is empty, and automated discovery (lead-gen) isn't available in this build yet. You can ${prepHint(s)} now; jobs appear once discovery ships.`;
const marketOverlay = (s: State) =>
  s.catalog.jobs === 0
    ? "(no market data yet — lead-gen is pending; coach on resume structure/clarity/impact for now, and don't fabricate demand)"
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
        : (!DISCOVERY_AVAILABLE || s.catalog.jobs === 0) ? `coach — ${prepHint(s)}; live job search opens once discovery ships`
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
      if (s.catalog.jobs === 0) gap.note = "zeros reflect pending lead-gen, not market demand";
      else if (s.catalog.ungraded_jobs > 0) gap.note = `${s.catalog.ungraded_jobs} jobs ungraded — grade them (look scope:'worklist') before reading the band count as final`;
    }
    const notes: string[] = [];
    if (!DISCOVERY_AVAILABLE && s.catalog.jobs === 0)
      notes.push(`automated lead-gen isn't available in this build yet — the catalog stays empty until discovery (gather) ships. You can ${prepHint(s)} now.`);
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
      `The one read door — never fetches, never writes, safe in any order. at='jobs' lists jobs by scope: 'market' (default, whole catalog; supports query + grading_status), 'relevant' (your level ±1 band with fit; levels ${ladder}), 'worklist' (the canonical grading queue — ungraded/stale rows). 'relevant' vs 'market' is a deliberate pair: the gap between them is the job-search signal (run both and contrast; for a precomputed gap use orient detail:'dashboard'). grading_status filters only the 'market' scope. at='companies' lists discovered companies. at='resume' / 'portfolio' read your materials; with_market_overlay adds the live-demand delta to coach against. at='packet' (needs job_id) gathers job + grade + skills + resume + fit + portfolio + any saved letter for one role. Returns JSON for you to interpret.`,
    inputSchema: {
      at: enumOf(["jobs", "companies", "resume", "portfolio", "packet"]),
      scope: enumOf(["relevant", "market", "worklist"]).optional(),
      query: z.string().optional(),
      grading_status: enumOf(["ungraded", "graded", "any"]).optional(),
      job_id: z.number().int().optional(),
      with_market_overlay: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    const s = readJourneyState();

    if (a.at === "companies") {
      const companies = DB.getCompanies(a.limit ?? 200);
      const out: Record<string, unknown> = { companies };
      if (companies.length === 0) out.note = DISCOVERY_AVAILABLE ? "no companies yet — run gather({ step: 'find_companies' })." : "no companies discovered yet — automated discovery isn't available in this build yet.";
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
      return json({ portfolio: repos, coverage_gaps: marketOverlay(s) });
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
      const rows = DB.db.prepare(
        `SELECT j.id, c.name AS company, j.title, j.location, j.grade_seniority, j.grade_market_signal,
                f.band AS fit, f.gaps_json AS fit_gaps_json, f.rationale AS fit_rationale
         FROM jobs j JOIN companies c ON c.id=j.company_id
         LEFT JOIN job_fit f ON f.job_id=j.id
         WHERE j.still_live=1 AND j.grade_seniority IN (${band.map(() => "?").join(",")})
         ORDER BY j.last_seen_at DESC LIMIT ?`,
      ).all(...band, limit) as any[];
      const jobs = rows.map(({ fit_gaps_json, ...rest }) => ({ ...rest, fit_gaps: fit_gaps_json ? JSON.parse(fit_gaps_json) : null }));
      return json({ band, jobs });
    }

    if (scope === "worklist") {
      const rows = DB.db.prepare(
        `SELECT id, title, location, raw_json, fetched_at, graded_at,
                CASE WHEN grade_seniority IS NULL THEN 'never_graded' ELSE 'stale' END AS reason
         FROM jobs WHERE still_live=1 AND (grade_seniority IS NULL OR graded_at < fetched_at)
         ORDER BY fetched_at ASC LIMIT ?`,
      ).all(a.limit ?? 25);
      const out: Record<string, unknown> = { count: rows.length, jobs: rows };
      if (rows.length === 0) out.note = s.catalog.jobs === 0 ? emptyCatalogNote(s) : "all jobs are graded.";
      return json(out);
    }

    // scope === "market" — whole-market view + general catalog search
    const limit = a.limit ?? 50;
    const where: string[] = ["j.still_live=1"]; const args: string[] = [];
    if (a.query) { where.push("(j.title LIKE ? OR c.name LIKE ?)"); args.push(`%${a.query}%`, `%${a.query}%`); }
    if (a.grading_status === "ungraded") where.push("j.grade_seniority IS NULL");
    if (a.grading_status === "graded") where.push("j.grade_seniority IS NOT NULL");
    const rows = DB.db.prepare(
      `SELECT j.id, c.name AS company, j.title, j.grade_seniority FROM jobs j JOIN companies c ON c.id=j.company_id
       WHERE ${where.join(" AND ")} ORDER BY j.last_seen_at DESC LIMIT ?`,
    ).all(...args, limit);
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

  // ── gather: the one door to the outside world (pending integrations) ──────
  const pending = pendingSteps();
  const gatherDesc =
    `${pending.length ? `[NOT YET AVAILABLE IN THIS BUILD: ${pending.join(", ")}] ` : ""}` +
    "The one door to the outside world — reach out and persist new data, then return it. step selects the integration: 'find_companies' (lead-gen + ATS slugs for a niche; needs niche), 'fetch_jobs' (a company's live ATS board → raw, ungraded jobs; needs ats_platform + ats_slug), 'ingest_portfolio' (the user's public GitHub repos; needs github_handle), 'sync_catalog' (bidirectional, catalog-only sync; uses dry_run to show the diff first). Persistence is a side effect of gathering — the agent still never writes the DB itself.";
  server.registerTool("gather", {
    description: gatherDesc,
    inputSchema: {
      step: enumOf(["find_companies", "fetch_jobs", "ingest_portfolio", "sync_catalog"]),
      niche: z.string().optional(),
      ats_platform: enumOf(["ashby", "greenhouse", "lever", "workable"]).optional(),
      ats_slug: z.string().optional(),
      github_handle: z.string().optional(),
      dry_run: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    // Each step is a stub until its capability flag flips; then replace planned()
    // with the real persister (write via a db.ts helper, then return the findings).
    switch (a.step) {
      case "find_companies": return planned("lead-gen + ATS-slug resolution for a niche");
      case "fetch_jobs": return planned("fetch + normalize a live ATS board");
      case "ingest_portfolio": return planned("fetch the user's public GitHub repos");
      case "sync_catalog": return planned("bidirectional catalog sync with an external pool");
      default: return json({ ok: false, error: `unknown gather step '${a.step}'` });
    }
  });
}
