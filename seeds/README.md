# seeds/ — the curated lead-gen roster

`companies.json` is the **free, default** source for `gather({ step: 'find_companies' })`
(the `curated` provider). It's a hand-maintained list of companies on the four supported
ATSes — the career-ops `portals.yml` model. It ships **empty** on purpose: the curated
path's whole value is precision, so the entries must be real and verified, never guessed.

To keep your roster outside the plugin dir (so it survives plugin updates), set
`JOBBOT_SEEDS_FILE` to its path; unset, this bundled `companies.json` is used.

## Format

A JSON array of company entries:

```json
[
  {
    "name": "Example Co",
    "domain": "example.com",
    "ats_platform": "greenhouse",
    "ats_slug": "exampleco",
    "tags": ["industry:fintech", "size:51-200", "funding:series_b"]
  },
  { "name": "Another Co", "domain": "another.io" }
]
```

- **`name`** (required) — display name.
- **`ats_platform` + `ats_slug`** (optional, but the point of curation) — `ashby` |
  `greenhouse` | `lever` | `workable` and the board slug. Entries that carry both arrive
  **slug-complete** and skip ATS resolution entirely (free, instant, no probing).
- **`domain`** (optional) — used for dedup and, if no slug is given, for resolution.
  An entry with only `name`/`domain` is resolved like any discovered company.
- **`tags`** (optional) — namespaced (`industry:…`, `size:…`, `funding:…`, `tech:…`),
  matching the company-tag vocabulary. Carried through to the catalog.

## How it's used

- The whole roster is returned by discovery; relevance (does this company want *your*
  title/seniority?) is filtered for free at `fetch_jobs` + grading time, not here.
- Re-runs dedup on `(ats_platform, ats_slug)` then `domain`, so re-adding a seed never
  duplicates it.
- Verify a slug before adding it: hit the board's public endpoint (e.g.
  `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs`) and confirm it 200s.

## Lighter than curating a list?

You don't have to seed anything to start. Name companies directly on the call —
`gather({ step: 'find_companies', companies: [{ name: 'Stripe', domain: 'stripe.com' }] })`
— and they're resolved and added on demand, zero roster, zero key. Reach for the curated
roster (or, later, Common Crawl harvest / TheirStack) when on-demand recall gets tedious.
