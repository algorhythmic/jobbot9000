# Offline people discovery — stage (b)

This slice collects synthetic professional contact evidence for private review.
It does not contact anyone, validate mailboxes, send invitations, create outreach
drafts, or expose an executor. Live discovery and real personal inputs remain on
hold. Stages (c), (d) and (e) are not implemented by this slice.

## Collection contract

`collectPeople({ id, sources })` is a local dry-run preview. It calls no adapter,
store or limiter. An explicit `execute: true` additionally requires injected
`fixtureOnly: true` transport, private store, shared read ledger and current
source policies. No environment setting or default transport enables network.
The marker describes the synthetic adapter contract; it cannot sandbox an
arbitrary injected function. Native network restrictions remain in effect.

Each source declares an opaque company ID, URL, kind (`job_post`, `official_team`
or `official_api`), and public/professional status. The normalized publication
connector accepts source text plus structured contact blocks. It is a fixture
publication/API seam, not a general HTML scraper or a live provider integration.
Only named recruiters or explicitly published hiring managers are accepted.
Unknown/ambiguous team matches remain `ambiguous` and always need review.
A public GitHub author or general manager title is not inferred to be a recruiter
or a role's hiring manager.

For each channel the exact full email address or professional URL must appear in
its quoted publication evidence, alongside the person's name and professional
context. Role evidence must also quote that person and their professional role.
The connector verifies publication text, quoted evidence and exact channel tokens;
it does not invent addresses or complete partial strings. Personal/private,
guessed/inferred and bought/purchased channel evidence is rejected. These are
source assertions for review, not independent verification of employment or
permission to send. No ping or lookup verifies the address.

`assertPeopleSourceUrl` is enforced before every transport call, including
redirects. It rejects LinkedIn domains/shortlinks, personal/social sources, local
or IP-literal hosts, credentials, login/OAuth/CAPTCHA/private/bought paths, and
non-HTTPS targets, including encoded/authority tricks. Exact-host source-policy
approval and expiry are checked again after a limiter wait. Unknown/private
source kinds fail closed. No page may override the collector's company/source
metadata. Future live transport would still require connected-IP/DNS validation
and actual operator terms review; neither is established by synthetic policies.

`operatorReferences: [{ personId, url }]` is a separate, explicit caller input.
It can retain an inert LinkedIn profile reference. A LinkedIn link extracted from
source contact data is rejected; a reference never becomes a fetch target or a
published contact channel. The private record validator permits inert references
and cannot authenticate a human caller. Thus operator origin is the trusted
application boundary, not a claim proved by a raw JSON record. No reference
provides authority to automate LinkedIn or contact its owner.

All source strings are untrusted data. They are parsed into bounded structured
fields, never passed to a shell, model, agent instruction, `eval` or tool
invocation. Unknown source commands are discarded. Returned collection results
contain only opaque run ID, status and counts; adapter/parser exception text is
not returned. The transport interface is a read-only GET with manual redirects,
AbortSignal and no send/submit method.

## Private queue and retention

All SQL writes remain in `src/db.ts`. `privatePeopleStore` opens the configured
`.private` SQLite database and stores the bounded finding and evidence payload.
The review queue is a private view of those retained findings, with professional
role evidence, explicitly published channels, ambiguity, provenance and expiry;
`needsReview` is always true. It is not the outbound review queue from stage (c).
Only a direct private reader receives the payload. The executive receives counts
and opaque references, never names, emails, excerpts or contact URLs.

Default evidence TTL is 30 days from the supplied fetch timestamp. The parser
accepts an explicit positive integer TTL; the collector permits up to 365 days.
Old evidence is not silently re-dated at collection. The collector counts and
skips expired evidence; review atomically purges expired payloads and withholds
future-dated records. `purgeExpired(now)` is also available explicitly. Housekeeping
is access-driven, not a background timer: invoke it at private workflow entry and
at retention maintenance intervals. Configuring a TTL does not schedule a daemon.
There is no proposed-outreach API here. A future outreach workflow must refresh
source evidence and suppression checks before even proposing contact, then use
the separately approved exact-batch send gate.

Suppression and deletion atomically remove payloads and review entries. Stable
identity excludes source-page URL, so a second publication cannot evade the
choice. Hash-only identity and published-channel tombstones prevent automatic
recollection, including a changed name with the same channel. Existing aliases
sharing a channel are conservatively removed too; this can suppress multiple
professionals using a shared recruiting inbox. Only opaque fingerprints/reasons
remain, with no restore/unsuppress path in this slice. Journal entries contain
opaque hashes/counts and generic event text, never contact payloads.

Deletion is verified as logical removal from retained rows and the queue.
`secure_delete` is enabled, but WAL files, backups and earlier snapshots can
retain historical pages under `.private`. This is not guaranteed physical
forensic erasure. Resolve backup/WAL retention and harness transcript storage
before any real personal use; no real inputs were used to establish this slice.

## Bounds and recovery

Collection initially caps ten companies and thirty page attempts per run,
including redirects/retries. It uses the shared stage (a) ledger (prefer
`privateReadLedger()` for durable daily quotas), one request per host at a time
and at least one second between starts. Retries on 429/server errors are capped
at two, retain the host slot through bounded Retry-After, and source denials stop
the collection. Timeouts/cancellation stop explicitly. Source scopes and all
operator references are validated before collection begins. No child worker,
login flow or fallback provider can widen access.

Record collection, deletion, expiry and audit writes are transactional. Failed
journal writes roll back their associated changes. A partly collected run may
retain already collected findings; replay of a finding upserts the same stable
identity and respects tombstones. No claim of resumable people-page cursors or
cross-process worker scheduling is made.

## Acceptance evidence

All fixtures use synthetic names and domains. No current site terms, real person,
mailbox, credential or job site was queried.

| Criterion ID | Implemented evidence | Synthetic test evidence |
| --- | --- | --- |
| connectors | Three normalized public professional publication kinds; exact published channel and role evidence | `test/people-sources.test.mjs`, `test/people.test.mjs` |
| denylist | Source and channel URL gates; LinkedIn reference-only path; redirect rechecks; unsupported/private sources rejected | `test/people-sources.test.mjs`, `test/people.test.mjs` |
| storage | Existing private-root DB, ingress validation, restrictive permissions, redacted journal | `test/people-store.test.mjs` |
| review-queue | Fresh private evidence view; ambiguous matches marked; empty company is valid; results are counts-only | `test/people-store.test.mjs`, `test/people.test.mjs` |
| suppression-deletion | Atomic payload removal, stable identity/channel tombstones, alias purge and recollection blocking | `test/people-store.test.mjs` |
| retention | 30-day default/configurable TTL, stale skips, future evidence withheld, expiry purge before review | All three people test scripts |
| tests | Global-fetch trap, read-only injected requests, source instructions inert, exception redaction, rollback/reopen and end-to-end private-store integration | All three people test scripts; `npm test`; `npm run typecheck` |
| local-only | Local branch, synthetic data, no live transport/send/submit or remote publishing | Git/checkpoint receipts under `.private/build/` |

Run `npm test` with installed dependencies. Its scripts use `node --import tsx`;
no tsx CLI IPC socket, live network or package install is needed. Receipts
separate source observations from executed synthetic checks and do not establish
live runtime readiness.
