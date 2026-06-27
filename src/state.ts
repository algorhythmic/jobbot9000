// state.ts — the journey state machine. State is derived from what data exists.
// The agent reads state; helpers (db.ts) update it. Nothing here judges. Tools
// surface honest, actionable notes when a precondition or data isn't ready.
import { getProfile, getMasterResume, getAssessment, getMeta, counts, applicationCounts } from "./db.js";

// To add a dimension: extend this union and add its predicate in readJourneyState
// (the Record<Dimension, boolean> makes the predicate mandatory at compile time),
// then have the relevant tools return an honest note when it's unmet.
export type Dimension =
  | "onboarded" | "level_assessed" | "portfolio_fetched" | "portfolio_graded" | "jobs_discovered" | "synced" | "has_applications";

export interface JourneyState {
  dimensions: Record<Dimension, boolean>;
  assessed_level: string | null;
  assessment: { level: string; rationale: string | null; evidence: unknown } | null;
  has_resume: boolean;
  profile: { target_role: string | null; target_niche: string | null; location_pref: string | null; github_handle: string | null; no_resume: boolean; no_github: boolean } | null;
  catalog: { companies: number; unresolved: number; jobs: number; ungraded_jobs: number };
  pipeline: Record<string, number>; // application counts by status (empty until the user applies)
  last_synced: string | null;
}

export function readJourneyState(): JourneyState {
  const profile = getProfile();
  const resume = getMasterResume();
  const assessment = getAssessment();
  const c = counts();
  const pipeline = applicationCounts();
  return {
    dimensions: {
      onboarded: !!profile,
      level_assessed: !!assessment,
      portfolio_fetched: c.portfolio > 0,
      portfolio_graded: c.portfolio_graded > 0,
      jobs_discovered: c.jobs > 0,
      synced: getMeta("last_synced") !== null,
      has_applications: Object.keys(pipeline).length > 0,
    },
    assessed_level: assessment?.level ?? null,
    assessment: assessment ? { level: assessment.level, rationale: assessment.rationale, evidence: assessment.evidence } : null,
    has_resume: !!resume,
    profile: profile
      ? {
          target_role: profile.target_role, target_niche: profile.target_niche,
          location_pref: profile.location_pref, github_handle: profile.github_handle,
          no_resume: !!profile.no_resume, no_github: !!profile.no_github,
        }
      : null,
    catalog: { companies: c.companies, unresolved: c.unresolved, jobs: c.jobs, ungraded_jobs: c.ungraded },
    pipeline,
    last_synced: getMeta("last_synced"),
  };
}
