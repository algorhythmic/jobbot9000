# Stage (c): offline preparation and immutable private review

This slice has no executor, transport, submission, mailbox validation or network
client. Preparation is a pure deterministic recipe compiler; persistence defaults
to dry-run. Fixtures are wholly synthetic. Real profiles remain on hold pending
private transcript/backup policy; no resume was searched for or imported here.

## Prepare and revise

`prepareDrafts(recipes, { now, isSuppressed })` independently compiles each
company/role recipe. It requires approved, fresh job/terms evidence, existing
role-fit vocabularies, a completed competency interview and explicitly verified
profile claims no higher than the verified floor or interview ceiling. Email
outreach additionally requires an approved, unambiguous stage (b) contact and an
exact published email channel refreshed within 24 hours. Only supplied verified
claims enter the body. A recipe's unsupported submission fields appear in
`manualCompletion`; they are never guessed. The existing `role_fit`, `interview`
and `cover_letter` mode constraints are reused. These mechanical checks cannot
prove the truth of an input profile: approved evidence is a caller trust boundary.

The mandatory suppression callback must check current private identity/channel
tombstones. `isPrivatePersonSuppressed` provides that read-only stage (b) bridge.
Preparation rejects repeated company/role keys, contacts and destinations.
Queue creation rechecks the compiled recipe, freshness, suppression and duplicates.
Source strings remain untrusted data and never become commands or model prompts.

`createReviewBatch(privateDir, input, { now, isSuppressed })` previews without
writes. Explicit `persist: true` publishes an immutable revision under:

```
.private/review/<opaque-batch-rN>/manifest.json
.private/review/<opaque-batch-rN>/items/<id>.json
.private/review/<opaque-batch-rN>/attachments/<id>
.private/review/<opaque-batch-rN>/review.md
.private/audit/events.jsonl
```

Use a new revision ID ending `-rN` and `previousBatchId` to edit a prior revision.
No existing revision can be overwritten through the API. Any draft, destination,
attachment byte or metadata change yields a new canonical payload SHA-256.
Manifest metadata, item inventory, item contents and exact attachment hashes are
bound. Revision expiry is explicit (maximum seven days), and current evidence may
expire sooner. Raw file edits are integrity failures, not an authorized revision.
A private staging directory is renamed only after artifact creation and audit;
a crash may leave an audit intent without a published batch, never send anything.

All directories/files are restricted to the literal `.private` root, checked for
links; private directories use 0700 and files 0600. Same-UID hostile path races are
not OS isolation. Private audit contains event kind, opaque IDs, digest and time,
not profile/contact/draft text. No worker scheduler is added in this slice.

## Review commands

Build explicitly with installed dependencies: `npm run build`. The package's
`jobbot` bin maps to `bin/jobbot.mjs`; without package linking use
`node bin/jobbot.mjs` with the same arguments. It never installs dependencies.
Set `JOBBOT_PRIVATE_DIR` to the intended absolute `.private` root; by default the
CLI uses the current workspace's `.private`. It never reads `~/.private/jobbot/`.

- `jobbot review <batch-rN>` verifies every artifact, current honesty/suppression
  and expiry, then prints the full preview and records private review audit.
- MCP `review_batch({ batch_id })` provides the same complete audited preview.
  It adds no approval or send capability. Real private output must not enter
  harness transcripts until the retention question is resolved.
- `jobbot approve-send <batch-rN> --sha256 <digest>` verifies the exact batch and
  records a private `approval_denied` audit, then **fails closed**.
- `jobbot revoke-approval <batch-rN>` records a private negative revocation audit;
  it cannot create or make an approval usable.

The preview is complete canonical JSON in an HTML-escaped preformatted block:
exact subject/body, destination/channel, all form/manual fields, complete recipe
and evidence, manifest/revision/expiry/digest, and complete attachment bytes as
base64. Nothing is truncated or executed; it is not a pretty rendered email.

## Approval record boundary

The record contract binds batch/revision/digest, exact destinations/channels,
attachment paths/hashes for each item, action count, actor, created/expiry times
and state. Approval TTL is at most ten minutes. Malformed, mismatched, expired,
revoked or consumed records fail closed. So do well-formed records.

**No operator-only identity separation is available in this runtime.** Workers
and the operator share an OS identity and accessible files. An actor string,
environment variable, local file, hash or worker-provided verifier cannot prove
operator approval. `requestOperatorApproval` always returns
`operator_boundary_unavailable`; `inspectUntrustedApproval` has no successful
return type. No signing secret, override flag, fake authority or minting API is
installed. No usable approval record can be created here. A future trusted,
operator-only service/interface must be separately designed and reviewed before
approval recording can be enabled. Stage (d) is a separate assignment.

## Explicit later resume import

Once the operator supplies the source and resolves real-data retention, use:

```
jobbot import-resume --source /explicit/operator-supplied/file --id resume-v1
jobbot import-resume --source /explicit/operator-supplied/file --id resume-v1 --write
```

The first command performs no source reads or output writes. The explicit
`--write` copies a bounded regular file to `.private/profile/<id>.resume`, with
0600 permissions and a private hash-only audit event. Existing imports are never
overwritten; a new ID is needed. Source/output links and nonprivate destinations
are rejected. Import does not infer claims, grade the profile or put bytes in
Git. Never put real inputs in the tracked synthetic fixture. No real file has
been read or sought during this build.

## Verification

`npm test` runs the offline Node scripts with `node --import tsx`.
`npm run lint` uses the existing TypeScript compiler (`tsc --noEmit`); the repo
has no separate ESLint dependency/configuration. `npm run build` checks the
compiled CLI/plugin output. No browser or network checks are needed or run.
Tests cover canonicalization, tampering, preview completeness/escaping, expiry,
forged/worker-created/revoked/consumed approvals, honesty, suppression/duplicates,
private temporary artifacts, import behavior, CLI and narrow MCP review, and a
no-network trap. Evidence and PR draft remain under `.private/` only.
