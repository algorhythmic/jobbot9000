import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectUntrustedApproval, requestOperatorApproval, markApprovalRevoked,
  OperatorApprovalUnavailableError, MAX_APPROVAL_TTL_MS,
} from '../src/approval.ts';

const now = new Date('2026-01-01T00:01:00.000Z');
const binding = () => ({
  batchId: 'synthetic-batch', revision: 1, payloadSha256: 'a'.repeat(64),
  destinations: [{ itemId: 'item-1', channel: 'email', destination: 'synthetic@example.test' }],
  attachments: [{ itemId: 'item-1', path: 'attachments/synthetic.txt', sha256: 'b'.repeat(64) }], actionCount: 1,
});
const record = () => ({ ...binding(), schemaVersion: 1, id: 'synthetic-approval', actor: 'synthetic-operator',
  createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z', state: 'approved' });
const reason = (approval, expected = binding(), at = now) => inspectUntrustedApproval(approval, expected, at).reason;

test('well-formed worker-created record cannot become approval', () => {
  assert.deepEqual(inspectUntrustedApproval(record(), binding(), now), { ok: false, reason: 'operator_boundary_unavailable' });
});
for (const actor of ['operator', 'root', 'synthetic-operator', 'worker', 'human-approved']) {
  test(`claimed identity ${actor} confers no authority`, () => {
    assert.equal(reason({ ...record(), actor }), 'operator_boundary_unavailable');
    assert.throws(() => requestOperatorApproval(binding(), actor), OperatorApprovalUnavailableError);
  });
}
test('every request fails closed, including missing or forged arguments', () => {
  for (const value of [undefined, null, {}, record(), { operator: true }, binding()]) {
    assert.throws(() => requestOperatorApproval(value, { authenticated: true }), error => error.code === 'operator_boundary_unavailable');
  }
});
for (const [label, mutate] of [
  ['payload digest', value => { value.payloadSha256 = 'c'.repeat(64); }],
  ['destination', value => { value.destinations[0].destination = 'different@example.test'; }],
  ['channel', value => { value.destinations[0].channel = 'application'; }],
  ['attachment bytes digest', value => { value.attachments[0].sha256 = 'd'.repeat(64); }],
  ['attachment path', value => { value.attachments[0].path = 'attachments/different.txt'; }],
  ['revision', value => { value.revision = 2; }],
  ['batch id', value => { value.batchId = 'different-batch'; }],
]) {
  test(`edited ${label} fails closed`, () => {
    const value = record(); mutate(value);
    assert.equal(reason(value), 'binding_mismatch');
  });
}
test('action count cannot be forged', () => assert.equal(reason({ ...record(), actionCount: 2 }), 'malformed_approval'));
test('expired and exact-expiry records fail closed', () => {
  assert.equal(reason(record(), binding(), new Date('2026-01-01T00:05:00.000Z')), 'expired');
  assert.equal(reason(record(), binding(), new Date('2026-01-02T00:05:00.000Z')), 'expired');
});
test('revoked and consumed records fail closed', () => {
  assert.equal(reason({ ...record(), state: 'revoked' }), 'revoked');
  assert.equal(reason({ ...record(), state: 'consumed' }), 'consumed');
});
test('future and overlong approval fail closed', () => {
  assert.equal(reason(record(), binding(), new Date('2025-12-31T23:59:59.000Z')), 'not_yet_valid');
  assert.equal(reason({ ...record(), expiresAt: '2026-01-01T00:11:00.000Z' }), 'approval_ttl_exceeded');
  assert.equal(MAX_APPROVAL_TTL_MS, 600000);
});
test('malformed records and malformed expected bindings fail closed', () => {
  for (const value of [null, undefined, [], {}, { ...record(), actor: '' }, { ...record(), state: 'sent' }, { ...record(), revision: 0 }, { ...record(), payloadSha256: 'bad' }])
    assert.equal(reason(value), 'malformed_approval');
  assert.equal(reason(record(), {}), 'malformed_binding');
});
test('invalid dates and negative TTL fail closed', () => {
  assert.equal(reason({ ...record(), expiresAt: '2026-02-31T00:05:00.000Z' }), 'malformed_approval');
  assert.equal(reason({ ...record(), expiresAt: record().createdAt }), 'approval_ttl_exceeded');
});
test('attachment and action identifiers cannot alias', () => {
  const duplicateAction = record(); duplicateAction.destinations.push({ ...duplicateAction.destinations[0] }); duplicateAction.actionCount++;
  assert.equal(reason(duplicateAction), 'malformed_approval');
  const duplicateAttachment = record(); duplicateAttachment.attachments.push({ ...duplicateAttachment.attachments[0] });
  assert.equal(reason(duplicateAttachment), 'malformed_approval');
});
test('property insertion order cannot create authentication', () => {
  const reversed = Object.fromEntries(Object.entries(record()).reverse());
  reversed.destinations = reversed.destinations.map(item => Object.fromEntries(Object.entries(item).reverse()));
  assert.equal(reason(reversed), 'operator_boundary_unavailable');
});
test('revocation is a nonmutating denial, never authentication', () => {
  const original = record(); const revoked = markApprovalRevoked(original);
  assert.equal(original.state, 'approved'); assert.equal(reason(revoked), 'revoked');
  revoked.destinations[0].destination = 'changed@example.test';
  assert.equal(original.destinations[0].destination, 'synthetic@example.test');
  assert.throws(() => markApprovalRevoked({}), /Malformed approval record/);
});
test('denial never includes private supplied actor or destination', () => {
  assert.throws(() => requestOperatorApproval(binding(), 'synthetic-private-actor'), error => {
    assert.doesNotMatch(error.message, /synthetic-private|example\.test/); return true;
  });
  assert.doesNotMatch(JSON.stringify(inspectUntrustedApproval(record(), binding(), now)), /synthetic|example\.test/);
});
