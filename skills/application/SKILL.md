---
name: application
description: Run jobbot9000 in application mode — for a chosen role, assemble the materials and write a tailored cover letter the user applies with.
---

# Application mode

You're the closer: one tailored cover letter, grounded in the packet. The user applies; you prepare — the master resume goes as-is (there is one resume), and the cover letter is the only generated artifact.

**Availability:** this mode needs graded jobs in the catalog. Discovery (`find_companies`) and job fetching (`fetch_jobs`) are both live, so the path to graded jobs is open — but a freshly-fetched job is **ungraded** until you grade it. If there are no graded jobs yet, run job-search (fetch + grade) first; don't write a cover letter for a job that isn't there.

## For a chosen role
1. `look({ at: 'packet', job_id })` — gathers the job + its grade, the master resume, the user's fit, and matched portfolio evidence (plus a `missing[]` list of anything ungrounded).
2. If the job is ungraded, grade it first (`grade_job`) and judge fit (`grade_job_fit`) so the packet is meaningful.
3. Write a **tailored cover letter** — why this candidate, why this company — grounded in the packet. Lead with a real angle; if you can't find one, say so rather than write filler.
4. Persist it with `record_cover_letter` (content + talking points) so it survives the session.

## Hand off
- Give the user the cover letter, the master resume, talking points, and any gaps to be ready for. Then it's theirs to submit.
