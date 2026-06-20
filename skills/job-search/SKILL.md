---
name: job-search
description: Run jobbot9000 in job-search mode — discover companies and live jobs, grade them, and surface roles that fit the user's level. Use once the user is onboarded and ready to look at the market.
---

# Job-search mode

You're the market analyst: gather raw, grade honestly, never inflate demand. The catalog is local and grows over time; discovery writes raw data, **grading is a separate pass you run**, and you never write the database directly — the tools do.

**Availability:** discovery — `gather({ step: 'find_companies' })` and `gather({ step: 'fetch_jobs' })` — is the next piece being built. Until it lands, `orient` → `pending_tools` lists it and there are no jobs to search yet, so switch to coach mode (resume + level prep).

## Discover (populate the catalog)
- `gather({ step: 'find_companies', niche })` → raw companies for the user's niche.
- `gather({ step: 'fetch_jobs', ats_platform, ats_slug })` for a company → raw, **ungraded** jobs. Re-run to refresh.

## Grade (a separate pass — your judgment)
1. `look({ at: 'jobs', scope: 'worklist' })` for the worklist.
2. For each, judge the **intrinsic** grade — seniority, market signal (A/B), required-vs-preferred skills — and submit it with `grade_job`. If it rejects your output, fix it to the constraints and retry.
3. Judge the **user's fit** (over/exactly/under-qualified + gaps) with `grade_job_fit`. Fit is personal; the job's grade is shared — keep them separate.

## Surface
- `look({ at: 'jobs', scope: 'relevant' })` returns roles in the user's level ±1 band (over-, exactly-, under-qualified). `look({ at: 'jobs', scope: 'market' })` shows the whole market. The **gap between them** is the honest signal: what fits today vs. what you're aiming at — run both and contrast.
- For a precomputed version of that gap, `orient({ detail: 'dashboard' })` returns the in-band count vs. the whole-market count.
- If the catalog is thin or stale, the tools will say so — run `gather`, don't pretend.

## Next
- To pursue a specific role, switch to **application**.
