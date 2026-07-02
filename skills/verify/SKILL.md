---
name: verify
description: Run jobbot9000's competency interview — the engine that assesses (the primary evidence for candidates with no portfolio), verifies the user actually built and understands their claims, AND upskills by showing what a great answer looks like. Use after onboarding/assessment and before job-search, or any time the profile rests on unverified self-report.
---

# Verify mode (the interview engine)

A resume and a GitHub are **claims, not proof.** The interview is the engine of the loop — it does three jobs at once: **assess** (depth shown by explaining, not linking — so this is how a strong engineer with no public portfolio is fairly assessed), **verify** (separate a builder from a confident résumé), and **upskill** (show the candidate the bar). Be **adversarial-but-supportive**: tell them up front it's for honest calibration *and* to learn what great looks like — not a gotcha.

## Orient first
- `orient` flags when the profile is unverified (`competency_verified: false`) and surfaces any open interview to resume. Interviews are **resumable** — pick up an in-progress session across turns/sessions.

## Read the picture
- `look({ at: 'competency' })` — the profile + which dimensions are thin/unverified. `look({ at: 'resume' })` and `look({ at: 'portfolio' })` — the headline claims (each flagship, each "shipped to real users", each senior-sounding skill) and the `verify` signals.

## Conduct the interview
Probe the load-bearing claims and the thin dimensions. Test, don't accept:
- **Ownership:** "Whose idea? Who else worked on it? Walk me through the part *you* wrote." (A 'we' that's really someone else's project, or a contributor graph that isn't theirs, changes everything.)
- **Understanding:** "Why X over Y? What broke and how did you fix it? Trace a request through your system. Reason this through from scratch."
- **Numbers:** "Where does that headline metric — the speedup, the coverage, the scale — come from? How did you measure it?"

Record with `record_interview`:
- `type: 'competency'` (general) — builds/verifies the profile, works with no portfolio.
- For EACH item: the question, the answer summary, a **grounded exemplar** ("what a great candidate at the target level would say" — anchored to the role/dimension bar, never vague), a `score`, and the **delta** (the gap → an upskilling target). For owned-work claims, also `ownership` + `understanding`.
- Append across turns; call with `done: true` + a `summary` to complete it. `verified_ceiling` caps an over-claim — and for a no-portfolio candidate it *establishes* the level.

## Re-assess honestly
- After the interview, **re-run `assess_competency` per dimension** with the now-demonstrated evidence: raise confidence only for what held up, set levels no higher than `verified_ceiling`, and for a no-portfolio candidate set the level the interview *earned* (don't leave them floored). A claim that didn't hold up must not inflate the profile or be featured.
- Turn each delta into a plan item — go to **jobbot9000:upskill**.

## Next
- Call `orient` — it routes (once the deltas become plan items, to **jobbot9000:upskill** to work them, then **jobbot9000:job-search**). Honest calibration is the gift: coaching a junior as a junior — or a quiet senior as a senior — is what actually gets them hired.
