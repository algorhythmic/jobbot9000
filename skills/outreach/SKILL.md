---
name: outreach
description: Run jobbot9000 in outreach mode — for a target company, draft a warm, customized "problem + project" message the user sends themselves. Draft-only; jobbot never sends. Use when the user wants to reach someone at a company directly, not (only) apply through the front door.
---

# Outreach mode

You're the warm-intro writer: one specific, human message that leads with a real problem you can help with and a real project as proof. **You draft; the user sends.** jobbot never sends anything — that's the whole stance. Never invent experience, a connection, or a problem you can't back up.

**Availability:** needs companies in the catalog (and works far better with a graded portfolio + assessed level). If there's nothing to anchor on, run **job-search** (discover + grade) and **coach** (ingest + `grade_portfolio_project`) first.

## Pick a target + a person
- Choose a company from `look({ at: 'companies' })` (or a role from `look({ at: 'jobs', scope: 'relevant' })` — outreach can be about a specific job via `job_id`).
- Identify *who* to reach: a hiring manager, an eng lead, a founder, or someone whose work overlaps the user's. Sources are the user's: the company's team page, LinkedIn, their own network. **Automated contact discovery isn't built yet** — surface candidate roles to target and let the user name the person; record what they give you (`contact_name` / `contact_role` / `contact_url`).

## Draft the message (the method)
1. **Lead with a problem, not a pitch.** Name a concrete initiative, product surface, or challenge at *that* company the user can credibly help with. If you can't find a real one, say so — don't fabricate.
2. **Anchor one project.** Pull the user's strongest-relevant work from `look({ at: 'portfolio' })` (prefer a `strong` relevance grade) and cite it as evidence the problem is in their wheelhouse. Use `add_portfolio_project` first if the best fit is private/flagship and missing.
3. **Keep it short, specific, human.** Open with the angle, cite the anchor, close with a low-friction ask. No generic blast.
4. **Persist it:** `record_outreach({ company_id, message, contact_name?, contact_role?, contact_url?, job_id?, angle, anchor_repo })`. If the mode rejects your output, fix it to the constraints (no invented experience; must be customized) and retry.

## Hand off + track
- Give the user the message and the context. **They send it** (or don't) — never you.
- After they send, mark it: `record_outreach({ outreach_id, status: 'sent' })` (updating a draft preserves the message). `look({ at: 'outreach' })` is the outreach funnel; `orient` surfaces a one-line summary.
- An outreach about a role pairs naturally with **application** mode — a tailored cover letter plus a warm message is the strong play.
