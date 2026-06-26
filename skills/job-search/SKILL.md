---
name: job-search
description: Run jobbot9000 in job-search mode — discover companies and live jobs, grade them, and surface roles that fit the user's level. Use once the user is onboarded and ready to look at the market.
---

# Job-search mode

You're the market analyst: gather raw, grade honestly, never inflate demand. The catalog is local and grows over time; discovery writes raw data, **grading is a separate pass you run**, and you never write the database directly — the tools do.

**Availability:** company discovery (`gather('find_companies')`) and live job fetching (`gather('fetch_jobs')`) are both **live and keyless** by default. Trust `orient` → `pending_tools` over this prose if they ever disagree (`ingest_portfolio` / `sync_catalog` are still pending).

## Discover companies (populate the catalog)
The reachable universe is companies on the four ATSes, so the **free path reaches everyone reachable** — start there. Three free-to-paid tiers, escalate only as recall demands:

1. **On-demand (lightest, zero-config):** when the user names targets, resolve them directly — `gather({ step: 'find_companies', companies: [{ name: 'Stripe', domain: 'stripe.com' }] })`. No key, no roster. First value with one call. If a company's board doesn't resolve (its ATS slug isn't derivable from name/domain — e.g. Glean is on Greenhouse under `gleanwork`), **pin it**: `companies: [{ name: 'Glean', ats_platform: 'greenhouse', ats_slug: 'gleanwork' }]` — taken slug-complete, then `fetch_jobs` confirms it.
2. **Curated roster (free, default):** with no `companies`/`provider` arg, discovery returns the local seed roster (`seeds/companies.json`) and resolves it. Empty out of the box — the tool's note tells you how to add seeds or name companies. Relevance (does this company want *your* role?) is filtered for free at fetch + grade time, not here.
3. **TheirStack (opt-in, paid):** for targeted "who's hiring my title now" discovery, set `THEIRSTACK_API_KEY` and pass `provider: 'theirstack'` with a query **you build from the resume** (stages 1–2 are yours — the server brings no model): titles, technologies, seniority (`junior|mid_level|senior|staff|c_level`), locations. **Count-first is free:** add `dry_run: true` to see the match count + projected cost. A paid pull stops and asks for `confirm: true` above the per-run ceiling (`THEIRSTACK_MAX_CREDITS_PER_RUN`, default 150); raise with `max_credits` or narrow the query.

Re-runs dedup on domain — you never re-add (or re-pay for) companies already held. Unresolved companies (no ATS slug found) are kept as candidates; resolved ones are slug-complete and ready for job fetching.

## Fetch jobs (populate the board → raw, ungraded jobs)
`gather({ step: 'fetch_jobs' })` pulls live ATS boards — keyless, free. Three ways to target:
- **One board:** `company_id` (a resolved company) or `ats_platform` + `ats_slug` (a known slug — auto-creates a minimal company if new). Good for "pull Stripe's board now."
- **All resolved:** pass nothing → refreshes every resolved company, stalest-first, bounded by `limit`. Polite delay between boards (Lever asks ~1s).

Each fetch is idempotent: new postings inserted, existing ones updated, and a **liveness pass** closes postings that vanished from the feed (`still_live=0`) so stale roles don't linger. An unreachable board (404/network) is skipped and reported, never fatal. Grades survive a refetch. Coverage: Greenhouse / Ashby / Lever are verified; **Workable is best-effort** (may under-report — confirm counts against the board). Then **grade** the new jobs (next section).

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
