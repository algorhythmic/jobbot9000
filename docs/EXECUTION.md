# Stage (d): Odin Option A approvals and mock execution

Only a synthetic mock adapter is implemented. There is no real email, application,
HTTP, browser, login or CAPTCHA adapter, and no worker CLI/MCP execution endpoint.
Enabling a real permitted channel requires a separate operator decision after the
end-to-end synthetic demonstration. Public job-board read APIs do not authorize
candidate submission APIs. No real batch or external site was used here.

## Issuance stays in Odin

Odin's authenticated operator NEEDS YOU Submit path must be the sole signing
issuer. Its deciding principal and exact reviewed batch digest are signed once.
JobBot does not implement that Odin UI/service, generate an operator signing key,
or mint approval. Stage (c)'s unsigned local records and approve-send command
remain fail-closed; its existing tests are retained unchanged.

Odin signs canonical UTF-8 JSON of the envelope below using Ed25519:

```
{ issuer: "odin", key_id, payload: {
  approval_id, batch_digest, principal, channel, destinations_digest,
  item_count, issued_at, expires_at, nonce
} }
```

The artifact adds a canonical base64 `signature`. Times are integer Unix
milliseconds; lifetime is positive and at most ten minutes. `signingBytes` defines
the canonical serialization but never signs. `destinations_digest` is SHA-256 of
canonical ordered `{id,channel,destination}` item objects. The batch digest binds
the immutable manifest, recipe, exact draft, destination and attachment hashes.
Issuer and key selector are signed too; they cannot be edited independently.

`verifyOdinApproval` checks strict schema, exact issuer/key, Ed25519 signature,
principal assertion, digest, destinations, channel, count and time bounds. A
principal is trusted only because Odin signed it, not because its string says
"operator". Odin is responsible for authenticating that principal and accepting
only an operator decision before signing.

## Protected public-key configuration

`loadOdinVerificationConfig(path)` reads only a config under a `.private` path:
`{ keyId, publicKeyPem }`. No key/config belongs in Git. No signing key belongs in
JobBot at all. Every path component must be free of symlinks and inaccessible to
worker writes; group/other writable components are rejected. JobBot does not
change owners, permissions, sandbox rules or services to manufacture this trust.

This is essential: if a worker can replace the verification key, it can make its
own signature appear valid. The current shared-UID workspace therefore **cannot
supply a production trust anchor**. Externally provision a protected readable
public-key config in an operator-owned `.private` hierarchy, with a privileged
Odin host and protected ledger, outside worker write capabilities. Actual Odin
key provisioning/NEEDS YOU integration is not installed or exercised by this
JobBot change. A key-rotation/integration decision belongs to that service owner.

The production host entry is `executeOdinApprovedBatch(input, deps)`. It always
loads that protected config and does not accept an inline authority. It is not
registered as an agent tool or general CLI command. The lower-level
`executeApprovedBatch` accepts a trusted startup dependency for synthetic testing;
it must not be exposed as a worker endpoint or accept request-supplied authority.
Only immutable branded mock adapters are admitted by either entry. Arbitrary
objects, callbacks and unbranded adapters are rejected. Thus even the test core
has no remote-effect capability.

## Execution and recovery

Dry-run is the default. No `send: true` means no consumption, intent or mock call.
The synthetic demo requires the literal `--send` flag to request a mock effect.
A send requires a valid Odin artifact and explicit send, a currently valid queue,
fresh source/terms/interview/verified-floor evidence, current suppression status,
no revocation and an unexecuted item. Unresolved manual fields are refused.
The initial envelope is one item; multi-action/partial batches are refused.

The private SQLite ledger atomically consumes unique `approval_id` and `nonce`
and writes an intent before calling the adapter. It stores the deciding principal
privately; event summaries expose only generic state and opaque IDs. Both single
use and item idempotency keys are enforced by unique constraints. Only one
intent/unknown effect may be active globally. No stage (e) worker scheduler is
introduced. A daily live-send quota is not granted by this change.

After reservation, policy, suppression, expiry, signature and item state are
rechecked immediately before the mock call. A failed recheck records a local
rejection-decision receipt without invoking transport. Receipt/state/audit writes
are transactional. Pre-effect refusal still consumes the approval; a later
attempt needs a new reviewed revision and approval, not reuse of the old token.

Any thrown adapter call or failed receipt commit is an unknown outcome. A durable
orphan intent is also unresolved. Neither is automatically resent, even with a
fresh approval. `reconcileApprovedExecution` only looks up the same idempotency
key and records a terminal receipt when known; no lookup result leaves it unknown.
The mock's lookup state is in memory: if a process restart loses that state,
reconciliation stays unknown and requires an operator investigation, not a retry.
Terminal records cannot be reopened. Revocation cannot create permission.

All records stay in the configured `.private` DB. SQLite/WAL/backups are subject
to the existing private-retention limits; this is not forensic erasure. Trusting
real principal/contact data also requires resolving harness transcript retention.
No actual approval files, real contact data, keys or outputs are committed.

## Synthetic demo

With installed dependencies:

```
npm run demo:stage-d
npm run demo:stage-d -- --send
npm run demo:stage-d -- --send --unknown
```

The first performs zero mock calls. The second creates a synthetic stage (c)
batch, simulates Odin signing with an in-memory throwaway test key, calls the mock
once, records the receipt and proves replay refusal. The third simulates
acceptance followed by timeout, then demonstrates lookup reconciliation with no
second call. Only opaque receipt IDs/counts/status and the private artifact path
are printed. Full synthetic batch/artifact/ledger/receipt are under a fresh
`.private/build/stage-d-demo/run-*/.private` root.

The signer lives only in `test/support/stage-d-demo.mjs` and verifier tests. Its
private key is never persisted. Its PUBLIC key file is intentionally worker-owned
and is **not** accepted by the protected production loader; the demo injects this
key only into the mock test core. A demo approval is not a production Odin-issued
approval. No production mint path or real-channel activation is demonstrated.

## Checks

`npm test` includes the unchanged stage (c) approval suite plus verifier, ledger
and executor tests. Throwaway keypairs exist only in synthetic tests. Refusals
cover missing send/artifact, wrong issuer/key/signature, worker-minted artifacts,
expiry, digest/destination/channel/count mismatch, edited batch/attachment,
revocation, replay/nonce reuse, malformed/private trust config, suppression races,
manual fields and multi-item batches. Tests also cover receipt/journal rollback,
orphan intents, acceptance-timeout reconciliation and no blind resend.
`npm run lint`, `npm run typecheck` and `npm run build` use installed tooling.
No network, credentials, live runtime, service or browser checks are performed.
