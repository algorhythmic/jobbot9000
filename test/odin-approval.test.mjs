import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { verifyOdinApproval, signingBytes, loadOdinVerificationConfig, OdinApprovalError } from '../src/approval.ts';

// Wholly synthetic, throwaway signer exists only in tests, never in JobBot production.
const keys = generateKeyPairSync('ed25519');
const workerKeys = generateKeyPairSync('ed25519');
const config = { keyId: 'synthetic-odin-key', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const now = 1770000000000;
const expected = { batchDigest: 'a'.repeat(64), destinationsDigest: 'b'.repeat(64), channel: 'mock', itemCount: 1 };
const payload = () => ({ approval_id: 'synthetic-approval', batch_digest: expected.batchDigest, principal: 'synthetic-operator-principal', channel: 'mock', destinations_digest: expected.destinationsDigest, item_count: 1, issued_at: now - 1000, expires_at: now + 60000, nonce: 'synthetic-nonce' });
function issue(changes = {}, signer = keys.privateKey, envelopeChanges = {}) {
  const envelope = { issuer: 'odin', key_id: config.keyId, payload: { ...payload(), ...changes }, ...envelopeChanges };
  return { ...envelope, signature: sign(null, signingBytes(envelope), signer).toString('base64') };
}
const refused = (artifact, binding = expected, cfg = config, at = now) => assert.throws(() => verifyOdinApproval(artifact, binding, cfg, at), error => error instanceof OdinApprovalError && error.code === 'odin_approval_denied' && !error.message.includes('synthetic'));

test('accepts an Odin-signed exact binding and returns an immutable detached assertion', () => {
  const artifact = issue(); const p = verifyOdinApproval(artifact, expected, config, now);
  assert.deepEqual(p, payload()); assert.ok(Object.isFrozen(p));
  artifact.payload.principal = 'changed'; assert.equal(p.principal, 'synthetic-operator-principal');
});
test('canonicalization is stable across all payload and envelope insertion orders', () => {
  const original = issue();
  const shuffled = Object.fromEntries(Object.entries(original).reverse());
  shuffled.payload = Object.fromEntries(Object.entries(shuffled.payload).reverse());
  assert.deepEqual(signingBytes(original), signingBytes(shuffled));
  assert.deepEqual(verifyOdinApproval(shuffled, expected, config, now), payload());
});
for (const [label, changes] of [
  ['expired', { expires_at: now }], ['future', { issued_at: now + 1 }],
  ['overlong TTL', { expires_at: now + 600000 }], ['negative issue time', { issued_at: -1 }],
  ['zero TTL', { expires_at: now - 1000 }], ['empty principal', { principal: '' }],
  ['control principal', { principal: 'operator\nworker' }], ['wrong batch digest', { batch_digest: 'c'.repeat(64) }],
  ['wrong destinations digest', { destinations_digest: 'd'.repeat(64) }], ['wrong channel', { channel: 'email' }],
  ['wrong item count', { item_count: 2 }], ['invalid count', { item_count: 0 }],
  ['extra payload field', { operator: true }], ['bad nonce', { nonce: '../worker' }],
  ['malformed digest', { batch_digest: 'ABC' }], ['fractional timestamp', { issued_at: now - .1 }],
]) test(`refuses signed ${label}`, () => refused(issue(changes)));
test('refuses worker-minted, forged, unsigned and wrong-issuer artifacts', () => {
  refused(issue({}, workerKeys.privateKey));
  const forged = issue(); forged.signature = Buffer.alloc(64).toString('base64'); refused(forged);
  const unsigned = issue(); delete unsigned.signature; refused(unsigned);
  refused(issue({}, keys.privateKey, { issuer: 'worker' }));
});
test('issuer and key ID are bound within the signed envelope', () => {
  const artifact = issue(); artifact.key_id = 'substituted-key';
  refused(artifact, expected, { ...config, keyId: 'substituted-key' });
  const other = issue({}, keys.privateKey, { issuer: 'worker' }); other.issuer = 'odin'; refused(other);
});
test('refuses edited authenticated principal, address digest or payload', () => {
  for (const [key, value] of [['principal', 'worker'], ['destinations_digest', 'c'.repeat(64)], ['nonce', 'new-nonce']]) {
    const artifact = issue(); artifact.payload[key] = value; refused(artifact);
  }
});
test('rejects malformed artifacts, expected bindings, times and keys without disclosing supplied data', () => {
  for (const value of [null, [], {}, { ...issue(), extra: true }, { ...issue(), signature: 'invalid' }]) refused(value);
  refused(issue(), { ...expected, itemCount: 2 }); refused(issue(), expected, config, NaN);
  refused(issue(), expected, { ...config, publicKeyPem: 'synthetic-not-key' });
  refused(issue(), expected, { ...config, keyId: 'untrusted-key' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  refused(issue(), expected, { ...config, publicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }) });
});
test('accessors, inherited payloads and noncanonical values fail closed', () => {
  const a = issue(); Object.defineProperty(a.payload, 'principal', { get() { throw new Error('should not execute'); }, enumerable: true }); refused(a);
  const b = issue(); Object.setPrototypeOf(b.payload, { worker: true }); refused(b);
  const c = issue(); c.payload.issued_at = Infinity; refused(c);
});
test('worker-writable .private trust anchors and symlinks fail closed', () => {
  const build = join(process.cwd(), '.private', 'build'); mkdirSync(build, { recursive: true });
  const dir = mkdtempSync(join(build, 'odin-verifier-test-'));
  try {
    const file = join(dir, 'public-key.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    assert.throws(() => loadOdinVerificationConfig(file), OdinApprovalError);
    const link = join(dir, 'link.json'); symlinkSync(file, link);
    assert.throws(() => loadOdinVerificationConfig(link), OdinApprovalError);
    assert.throws(() => loadOdinVerificationConfig('relative/.private/key.json'), OdinApprovalError);
    assert.throws(() => loadOdinVerificationConfig('/tmp/not-private-key.json'), OdinApprovalError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
