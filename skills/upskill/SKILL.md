---
name: upskill
description: Run jobbot9000 in upskilling mode — turn the gaps surfaced by the interview and assessment into a tracked plan (learn / resume / build), help rebuild the resume from real evidence, and recommend portfolio projects that close in-demand gaps. Use after a competency or role-fit interview, or whenever the user wants to become more qualified.
---

# Upskill mode

This is the flywheel: the interview surfaced gaps and the bar; now turn them into concrete, tracked work that raises **real** fitness — and feeds the loop, because closing gaps re-opens a higher band of roles.

## Orient first
- `orient` shows open plan items to resume and where the user is. The plan persists across sessions — months of progress live in the DB.

## Build the plan (market-grounded, tracked)
- From the interview deltas + the competency gaps + the market overlay (`look({ at: 'resume', with_market_overlay: true })` or `orient({ detail: 'dashboard' }).market_demand`), call `recommend_upskilling` with items. Each has a `type`:
  - **learn** — a specific skill/topic with what to *do* (not "learn distributed systems" but "build and load-test a sharded KV store").
  - **resume** — a specific honest change (reframe a bullet, quantify a *real* outcome, surface a buried strength).
  - **build** — a portfolio **project to ship** that closes an in-demand gap. Ground it: prefer skills the live graded jobs in the band actually ask for, and say which in-demand skill each item closes (`market_demand`).
- Keep it short and achievable — a plan that moves the needle, not a wish list.

## Rebuild the resume (real evidence only)
- `set_resume({ content, rationale })` drafts/rewrites the master resume; the rationale marks it a coached revision and journals it (history in `look({ at: 'history' })`). ALLOWED: restructure, sharpen verbs, quantify REAL impact, surface buried strengths, tailor to a target role. **BLOCKED (the guardrail): invent jobs/titles/dates/metrics or inflate scope.** If a strong-sounding claim isn't backed, route it to the competency interview instead of polishing it in. When unsure a claim is real, ask the user.

## Track progress → re-match (close the loop)
- `update_plan_progress({ item_id, status })` — `suggested → in_progress → done`. Find ids via `look({ at: 'plan' })`.
- When an item is **done**, the user genuinely improved: re-assess the dimension it addressed (`assess_competency`), and re-run `look({ at: 'jobs', scope: 'relevant' })` — a higher band may now be in reach. That re-match is the loop turning.

## Next
- Call `orient` — it routes: as fitness rises, to **jobbot9000:job-search** for the newly-reachable roles, or **jobbot9000:application** to pursue one.
