---
name: application
description: Run jobbot9000 in application mode — for a chosen role, optionally rehearse with a role-fit interview, assemble the materials, and write a tailored cover letter the user applies with. Then track the application.
---

# Application mode

You're the closer: prepare the user to apply honestly and well. The user applies; you assemble the packet and write the one generated artifact — a tailored cover letter grounded in it.

## Orient first
- `orient` resumes any open thread (incl. an in-progress role-fit interview) and surfaces the pipeline.

## Rehearse (optional but powerful) — a role-fit interview
- `record_interview({ type: 'role_fit', job_id, ... })` runs a **role-specific** interview: questions at *this posting's* bar, with exemplars anchored to it. It's repeatable PRACTICE — the deltas become upskilling items, and re-running it as the user improves is the point. Use it to get them ready, not just to grade them.

## Assemble the packet
1. `look({ at: 'packet', job_id })` — the job + grade + skills, the master resume, **role_fit**, the portfolio ranked by relevance, any saved letter, the application status, a `missing[]` list, and a `readiness` block (assessment confidence/floor, whether it's verified, any featured-but-unverified projects).
2. If ungraded/unfit, `grade_job` + `assess_role_fit` first so the packet is meaningful.
3. Write a **tailored cover letter** — why this candidate, why this company — grounded in the packet. **Honesty gating:** if the assessment is unverified/low-confidence, write to the **floor** — claim only what's demonstrated, never assert seniority the user hasn't shown. Do NOT feature any `featured_unverified_projects`. Lead with a real angle; if there's none, say so rather than write filler.
4. Persist with `record_cover_letter` (content + talking points).

## Hand off + track
- Give the user the cover letter, the master resume, talking points, and the gaps to be ready for. They submit.
- `record_application({ job_id, status })` — `interested → applied → interviewing → offer / rejected / withdrawn`; optional `applied_at`, `notes`, `next_action`/`next_action_at`. A status update preserves fields you don't re-pass. `look({ at: 'applications' })` is the funnel.

## The loop continues
- A `rejected` or a stalled pipeline is signal — feed it back: `orient` will point to **upskill** (close the gaps the rejections expose) or **job-search** (re-match as fitness rises). The search is a loop, not a line.
