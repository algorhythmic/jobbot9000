// state.ts — the journey state machine, v2: a LOOP, not a line. State is derived from what
// data exists; the agent reads it, helpers (db.ts) update it. Nothing here judges. Because
// the whole journey persists in the DB, this is also the rehydration surface — a fresh
// session reads it (via orient) and resumes, including any open thread (an unfinished
// interview, in-progress plan items).
import {
  getProfile, getMasterResume, getAssessmentSummary, getCompetencyProfile, getOpenInterview,
  getMeta, counts, applicationCounts, planCounts, type Desires,
} from "./db.js";

// To add a dimension: extend this union and add its predicate in readJourneyState.
export type Dimension =
  | "onboarded" | "profiled" | "verified" | "portfolio_fetched" | "portfolio_graded"
  | "jobs_discovered" | "has_plan" | "has_applications";

export interface JourneyState {
  dimensions: Record<Dimension, boolean>;
  // The derived, multi-dimensional assessment (band + per-dimension brief). assessed_level
  // mirrors the band for back-compat with band math (matching, relevant scope).
  assessed_level: string | null;
  assessment: { band: string | null; confidence: string | null; floor: string | null; verified: boolean } | null;
  competency: { dimension: string; level: string; confidence: string }[];
  open_interview: { id: number; type: string; job_id: number | null } | null; // a thread to resume
  has_resume: boolean;
  profile: {
    target_role: string | null; target_niche: string | null; location_pref: string | null;
    github_handle: string | null; desires: Desires | null; no_resume: boolean; no_github: boolean;
  } | null;
  catalog: { companies: number; unresolved: number; jobs: number; ungraded_jobs: number };
  plan: Record<string, number>;     // upskilling-plan counts by status
  pipeline: Record<string, number>; // application counts by status
}

export function readJourneyState(): JourneyState {
  const profile = getProfile();
  const resume = getMasterResume();
  const summary = getAssessmentSummary();
  const competency = getCompetencyProfile();
  const open = getOpenInterview();
  const c = counts();
  const plan = planCounts();
  const pipeline = applicationCounts();
  return {
    dimensions: {
      onboarded: !!profile,
      profiled: c.dimensions_assessed > 0,
      verified: c.interviews_complete > 0,
      portfolio_fetched: c.portfolio > 0,
      portfolio_graded: c.portfolio_graded > 0,
      jobs_discovered: c.jobs > 0,
      has_plan: c.plan_open > 0,
      has_applications: Object.keys(pipeline).length > 0,
    },
    assessed_level: summary?.band ?? null,
    assessment: summary ? { band: summary.band, confidence: summary.confidence, floor: summary.floor, verified: !!summary.verified } : null,
    competency: competency.map((d) => ({ dimension: d.dimension, level: d.level, confidence: d.confidence })),
    open_interview: open ? { id: open.id, type: open.type, job_id: open.job_id } : null,
    has_resume: !!resume,
    profile: profile
      ? {
          target_role: profile.target_role, target_niche: profile.target_niche,
          location_pref: profile.location_pref, github_handle: profile.github_handle,
          desires: profile.desires, no_resume: !!profile.no_resume, no_github: !!profile.no_github,
        }
      : null,
    catalog: { companies: c.companies, unresolved: c.unresolved, jobs: c.jobs, ungraded_jobs: c.ungraded },
    plan,
    pipeline,
  };
}
