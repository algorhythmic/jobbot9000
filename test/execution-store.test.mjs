// Synthetic fixtures only: no remote operations, credentials or production DBs.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const fixture = mkdtempSync(join(tmpdir(), 'jobbot-execution-store-'));
process.env.JOBBOT_PRIVATE_DIR = join(fixture, '.private');
process.env.STATE_DIR = join(fixture, '.private', 'state');
const previousFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = () => { network++; throw new Error('network forbidden'); };
const DB = await import('../src/db.ts');
const { privateExecutionStore: store } = await import('../src/execution-store.ts');
after(() => { DB.db.close(); globalThis.fetch = previousFetch; rmSync(fixture, { recursive: true, force: true }); });
const hex = n => n.toString(16).padStart(64, '0');
let next = 1;
const intent = (override = {}) => {
  const base = next++ * 10;
  return { executionId: hex(base), principal: 'synthetic-operator', approvalId: hex(base+1), nonce: hex(base+2), batchDigest: hex(base+3),
    itemId: hex(base+4), idempotencyKey: hex(base+5), createdAt: 1000, ...override };
};
const count = table => DB.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const complete = value => { store.begin(value); store.finish(value.executionId, 'succeeded', hex(999), 1001); };

test('begin commits approval/nonce consumption and durable intent together', () => {
  const value = intent(); store.begin(value);
  assert.deepEqual(store.get(value.executionId), { ...value, state: 'intent', updatedAt: 1000 });
  assert.equal(DB.db.prepare('SELECT approval_id FROM execution_consumptions WHERE approval_id=?').get(value.approvalId).approval_id, value.approvalId);
  store.finish(value.executionId, 'succeeded', hex(999), 1001);
  assert.equal(store.get(value.executionId).state, 'succeeded');
  assert.equal(store.get(value.executionId).principal, 'synthetic-operator');
});

test('consumed approval ID and nonce reject second use independently', () => {
  const value = intent(); complete(value);
  assert.throws(() => store.begin(intent({ approvalId: value.approvalId })), /consumed/);
  assert.throws(() => store.begin(intent({ nonce: value.nonce })), /consumed/);
});

test('idempotency key prevents repeat effect and rolls back consumption', () => {
  const value = intent(); complete(value);
  const duplicate = intent({ idempotencyKey: value.idempotencyKey });
  const before = count('execution_consumptions');
  assert.throws(() => store.begin(duplicate), /UNIQUE/);
  assert.equal(count('execution_consumptions'), before);
  assert.equal(store.get(duplicate.executionId), undefined);
});

test('revoked approval is refused and revocation is durable', () => {
  const value = intent(); store.revoke(value.approvalId, 999);
  assert.equal(store.isRevoked(value.approvalId), true);
  assert.throws(() => store.begin(value), /revoked/);
  assert.equal(store.get(value.executionId), undefined);
});

test('begin audit failure rolls back consumption and intent', () => {
  const value = intent(); const before = count('execution_consumptions');
  DB.db.exec("CREATE TRIGGER fail_execution_begin BEFORE INSERT ON events WHEN NEW.kind='execution_intent' BEGIN SELECT RAISE(ABORT,'synthetic begin failure'); END");
  try { assert.throws(() => store.begin(value), /synthetic begin failure/); }
  finally { DB.db.exec('DROP TRIGGER fail_execution_begin'); }
  assert.equal(count('execution_consumptions'), before);
  assert.equal(store.get(value.executionId), undefined);
  complete(value);
});

test('receipt write failure preserves committed intent and consumed approval', () => {
  const value = intent(); store.begin(value); const before = count('execution_receipts');
  DB.db.exec("CREATE TRIGGER fail_execution_receipt BEFORE INSERT ON execution_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  try { assert.throws(() => store.finish(value.executionId, 'succeeded', hex(999), 1001), /synthetic receipt failure/); }
  finally { DB.db.exec('DROP TRIGGER fail_execution_receipt'); }
  assert.equal(store.get(value.executionId).state, 'intent');
  assert.equal(count('execution_receipts'), before);
  assert.throws(() => store.begin(value), /reconciliation/);
  store.reconcile(value.executionId, 'succeeded', hex(999), 1002);
  assert.equal(store.get(value.executionId).state, 'succeeded');
});

test('receipt audit failure also rolls back receipt and state', () => {
  const value = intent(); store.begin(value); const before = count('execution_receipts');
  DB.db.exec("CREATE TRIGGER fail_execution_finish BEFORE INSERT ON events WHEN NEW.kind='execution_receipt' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  try { assert.throws(() => store.finish(value.executionId, 'rejected', hex(999), 1001), /synthetic audit failure/); }
  finally { DB.db.exec('DROP TRIGGER fail_execution_finish'); }
  assert.equal(store.get(value.executionId).state, 'intent'); assert.equal(count('execution_receipts'), before);
  store.reconcile(value.executionId, 'rejected', hex(999), 1002);
});

test('unknown effect blocks all new intents until reconciled, without resend API', () => {
  const value = intent(); store.begin(value); store.finish(value.executionId, 'unknown', undefined, 1001);
  assert.throws(() => store.begin(intent()), /reconciliation/);
  assert.throws(() => store.finish(value.executionId, 'succeeded', hex(999), 1002), /reopened/);
  store.reconcile(value.executionId, 'succeeded', hex(999), 1002);
  assert.equal(store.get(value.executionId).state, 'succeeded');
  assert.equal(DB.db.prepare('SELECT COUNT(*) n FROM execution_receipts WHERE execution_id=?').get(value.executionId).n, 2);
  complete(intent());
});

test('terminal receipt cannot be changed or reopened', () => {
  const value = intent(); complete(value);
  for (const state of ['succeeded', 'rejected', 'unknown']) assert.throws(() => store.finish(value.executionId, state, hex(999), 1002), /reopened/);
  assert.throws(() => store.reconcile(value.executionId, 'rejected', hex(999), 1002), /reopened/);
});

test('invalid identifiers and timestamps fail before ledger writes', () => {
  const before = count('execution_consumptions');
  for (const key of ['executionId', 'approvalId', 'nonce', 'itemId', 'idempotencyKey', 'batchDigest']) {
    for (const bad of ['', 'synthetic@example.test', '../outside', null]) assert.throws(() => store.begin(intent({ [key]: bad })));
  }
  for (const bad of [-1, 0.5, NaN, Infinity, 8640000000000001]) assert.throws(() => store.begin(intent({ createdAt: bad })), /timestamp/);
  for (const bad of ['', ' operator ', null, 'x'.repeat(257), 'actor\nnew']) assert.throws(() => store.begin(intent({ principal: bad })), /principal/);
  assert.equal(count('execution_consumptions'), before);
});

test('result validation preserves intent until a valid reconciled terminal receipt', () => {
  const value = intent(); store.begin(value);
  assert.throws(() => store.finish(value.executionId, 'succeeded', undefined, 1001), /receipt/);
  assert.throws(() => store.finish(value.executionId, 'succeeded', 'body@example.test', 1001), /identifier/);
  assert.throws(() => store.finish(value.executionId, 'succeeded', hex(999), 999), /regressed/);
  assert.throws(() => store.reconcile(value.executionId, 'unknown', hex(999), 1001), /result/);
  assert.equal(store.get(value.executionId).state, 'intent');
  store.reconcile(value.executionId, 'rejected', hex(999), 1002);
});

test('private files and journal contain no bodies or destinations and no network ran', () => {
  assert.deepEqual(readdirSync(fixture), ['.private']);
  assert.equal(statSync(process.env.JOBBOT_PRIVATE_DIR).mode & 0o777, 0o700);
  const events = DB.db.prepare("SELECT kind,summary,ref FROM events WHERE kind LIKE 'execution_%'").all();
  assert.ok(events.length > 0);
  assert.ok(events.every(row => !JSON.stringify(row).includes('@') && !JSON.stringify(row).includes('example.test') && !JSON.stringify(row).includes('synthetic-operator')));
  assert.equal(network, 0);
});


test('independent runtime reopening preserves consumed ID/nonce and deciding principal', () => {
  const value = intent(); complete(value);
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    globalThis.fetch = () => { throw new Error('network forbidden'); };
    const { privateExecutionStore: store } = await import('./src/execution-store.ts');
    const DB = await import('./src/db.ts');
    const value = ${JSON.stringify(value)};
    try {
      assert.equal(store.get(value.executionId).principal, 'synthetic-operator');
      assert.equal(store.get(value.executionId).state, 'succeeded');
      assert.throws(() => store.begin({ ...value, executionId: '${hex(99001)}', idempotencyKey: '${hex(99002)}' }), /consumed/);
    } finally { DB.db.close(); }
  `], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
