// Synthetic mock-only executor tests. Generated private artifacts never leave .private.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { executeApprovedBatch, executeOdinApprovedBatch, executionBinding, reconcileApprovedExecution } from '../src/executor.ts';
import { createMockTransport } from '../src/mock-transport.ts';
import { prepareDrafts } from '../src/preparation.ts';
import { createReviewBatch } from '../src/review-queue.ts';
import { signingBytes } from '../src/odin-approval.ts';
const now = 1800000000000;
const base = resolve('.private/test-stage-d-executor'); mkdirSync(base, { recursive: true, mode: 0o700 });
const temp = mkdtempSync(join(base, 'case-'));
const profile = JSON.parse(readFileSync(new URL('./fixtures/synthetic-profile.json', import.meta.url), 'utf8'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const authority = { keyId: 'synthetic-key', publicKeyPem: publicKey.export({type:'spki',format:'pem'}) };
let network = 0; const fetch = globalThis.fetch;
globalThis.fetch = () => { network++; throw new Error('network prohibited'); };
after(() => { globalThis.fetch = fetch; rmSync(temp, {recursive:true,force:true}); assert.equal(network,0); });
function fixture({manual = false} = {}) {
  const privateDir = join(mkdtempSync(join(temp,'fixture-')), '.private');
  const recipe = { profile: structuredClone(profile), evidence: {approved:true,companyId:'synthetic-company',roleId:'synthetic-role',companyName:'Synthetic Company',roleTitle:'Synthetic Engineer',sourceUrl:'https://careers.example.test/jobs/synthetic',description:'Synthetic public job.',fetchedAt:now-1000,expiresAt:now+100000,terms:{allowed:true,reference:'https://careers.example.test/terms',checkedAt:now-1000,expiresAt:now+100000},roleFit:{band:'exact',desireAlignment:'strong',rationale:'Synthetic match.'}},channel:'manual_application',destination:'https://careers.example.test/jobs/synthetic',claimIds:['fixture-claim'],requestedLevel:'mid',requiredFields:manual?['unsupported']:[] };
  const items = prepareDrafts([recipe], {now,isSuppressed:()=>false});
  const batch = createReviewBatch(privateDir,{batchId:'synthetic-r1',revision:1,createdAt:now,expiresAt:now+50000,items},{now,isSuppressed:()=>false,persist:true});
  const store = new MemoryStore();
  const adapter = createMockTransport();
  const deps = {store, adapter, authority, isSuppressed:()=>false, now:()=>now};
  return { privateDir, batchId:'synthetic-r1', batch, deps };
}
class MemoryStore {
  records = new Map(); approvals = new Set(); nonces = new Set(); keys = new Set(); revoked = new Set();
  begin(intent) {
    if(this.approvals.has(intent.approvalId)||this.nonces.has(intent.nonce)||this.keys.has(intent.idempotencyKey)||[...this.records.values()].some(v=>['intent','unknown'].includes(v.state))) throw new Error('denied');
    this.approvals.add(intent.approvalId);this.nonces.add(intent.nonce);this.keys.add(intent.idempotencyKey);this.records.set(intent.executionId,{...intent,state:'intent',updatedAt:intent.createdAt});
  }
  finish(id,state,receiptId,at) {if(['succeeded','rejected'].includes(state)&&!receiptId)throw new Error('missing receipt');const r=this.records.get(id);if(!r||r.state!=='intent')throw new Error('denied');this.records.set(id,{...r,state,receiptId,updatedAt:at});}
  get(id) { const r=this.records.get(id); return r&&structuredClone(r); }
  reconcile(id,state,receiptId,at) {const r=this.records.get(id);if(!r||!['intent','unknown'].includes(r.state))throw new Error('denied');this.records.set(id,{...r,state,receiptId,updatedAt:at});}
  revoke(id) {this.revoked.add(id);} isRevoked(id) {return this.revoked.has(id);}
}
function artifact(batch, changes={}, key=privateKey) {
  const b=executionBinding(batch);
  const envelope={issuer:'odin',key_id:authority.keyId,payload:{approval_id:'synthetic-approval',nonce:'synthetic-nonce',principal:'synthetic-operator',batch_digest:b.batchDigest,channel:b.channel,destinations_digest:b.destinationsDigest,item_count:b.itemCount,issued_at:now-1000,expires_at:now+30000,...changes}};
  return {...envelope,signature:sign(null,signingBytes(envelope),key).toString('base64')};
}
const run=(f,extra={})=>executeApprovedBatch({privateDir:f.privateDir,batchId:f.batchId,send:true,approval:artifact(f.batch),...extra},f.deps);
test('dry-run default has zero adapter calls and approval consumption',async()=>{const f=fixture();const r=await run(f,{send:undefined});assert.equal(r.status,'dry_run');assert.equal(f.deps.adapter.sendCalls,0);assert.equal(f.deps.store.records.size,0);});
test('valid approval performs exactly one mock effect and replay refuses',async()=>{const f=fixture();const r=await run(f);assert.equal(r.status,'succeeded');assert.equal(f.deps.store.get(r.executionId).state,'succeeded');await assert.rejects(run(f));assert.equal(f.deps.adapter.sendCalls,1);});
for(const [name,change] of [['expired',{expires_at:now}],['wrong digest',{batch_digest:'a'.repeat(64)}],['wrong destination',{destinations_digest:'b'.repeat(64)}],['wrong channel',{channel:'email'}],['future',{issued_at:now+1}],['missing principal',{principal:''}]])test(`refuses ${name}`,async()=>{const f=fixture();await assert.rejects(run(f,{approval:artifact(f.batch,change)}));assert.equal(f.deps.adapter.sendCalls,0);assert.equal(f.deps.store.records.size,0);});
test('forged, wrong issuer, worker minted and missing approvals refuse',async()=>{for(const type of ['forged','issuer','worker','missing']){const f=fixture();let a=artifact(f.batch);if(type==='forged')a.signature='A'.repeat(86)+'==';if(type==='issuer')a.issuer='worker';if(type==='worker')a=artifact(f.batch,{},generateKeyPairSync('ed25519').privateKey);if(type==='missing')a=undefined;await assert.rejects(run(f,{approval:a}));assert.equal(f.deps.adapter.sendCalls,0);}});
test('edited batch fails closed before claiming approval',async()=>{const f=fixture();const p=join(f.privateDir,'review',f.batchId,'items',f.batch.items[0].id+'.json');const v=JSON.parse(readFileSync(p));v.destination='https://different.example.test/';writeFileSync(p,JSON.stringify(v));await assert.rejects(run(f));assert.equal(f.deps.adapter.sendCalls,0);});
test('suppression and expiry rechecked after transactional reservation',async()=>{for(const mode of ['suppression','expiry','revocation']){const f=fixture();let reserved=false;const begin=f.deps.store.begin.bind(f.deps.store);f.deps.store.begin=i=>{begin(i);reserved=true;if(mode==='revocation')f.deps.store.revoke(i.approvalId);};f.deps.isSuppressed=()=>mode==='suppression'&&reserved;f.deps.now=()=>mode==='expiry'&&reserved?now+50000:now;const r=await run(f);assert.equal(r.status,'rejected');assert.equal(f.deps.adapter.sendCalls,0);}});
test('pre-revoked approval refuses without consuming or sending',async()=>{const f=fixture();f.deps.store.revoke('synthetic-approval');await assert.rejects(run(f));assert.equal(f.deps.store.records.size,0);assert.equal(f.deps.adapter.sendCalls,0);});
test('timeout after acceptance stays unknown until read-only reconciliation',async()=>{const f=fixture();f.deps.adapter=createMockTransport({behavior:'accept_then_timeout'});const r=await run(f);assert.equal(r.status,'unknown');await assert.rejects(run(f));const reconciled=await reconcileApprovedExecution(r.executionId,f.deps);assert.equal(reconciled.status,'succeeded');assert.equal(f.deps.adapter.sendCalls,1);assert.equal(f.deps.adapter.lookupCalls,1);});
test('provider rejection persists rejection and never retries',async()=>{const f=fixture();f.deps.adapter=createMockTransport({behavior:'reject'});const r=await run(f);assert.equal(r.status,'rejected');await assert.rejects(run(f));assert.equal(f.deps.adapter.sendCalls,1);});
test('receipt persistence failure leaves intent reconcilable without resend',async()=>{const f=fixture();f.deps.store.finish=()=>{throw new Error('synthetic crash');};const r=await run(f);assert.equal(r.status,'unknown');assert.equal(f.deps.store.get(r.executionId).state,'intent');assert.equal((await reconcileApprovedExecution(r.executionId,f.deps)).status,'succeeded');assert.equal(f.deps.adapter.sendCalls,1);});
test('unresolved intent with lost mock state stays unknown without resend',async()=>{const f=fixture();f.deps.store.finish=()=>{throw new Error('synthetic crash');};const r=await run(f);f.deps.adapter=createMockTransport();assert.equal((await reconcileApprovedExecution(r.executionId,f.deps)).status,'unknown');assert.equal(f.deps.adapter.sendCalls,0);});
test('arbitrary transports and forged brands are rejected',async()=>{const f=fixture();let calls=0;f.deps.adapter={send:async()=>{calls++;},lookup:async()=>undefined};await assert.rejects(run(f));assert.equal(calls,0);});
test('manual unsupported fields require operator manual handoff',async()=>{const f=fixture({manual:true});await assert.rejects(executeApprovedBatch({privateDir:f.privateDir,batchId:f.batchId,send:true,approval:{}},f.deps));assert.equal(f.deps.adapter.sendCalls,0);});
test('multi-action batches refused before any transport',()=>{const f=fixture();assert.throws(()=>executionBinding({...f.batch,items:[...f.batch.items,...f.batch.items]}));assert.equal(f.deps.adapter.sendCalls,0);});
test('mock instances cannot be patched to introduce remote effects',()=>{const mock=createMockTransport();assert.throws(()=>{mock.send=async()=>{};});assert.throws(()=>{Object.getPrototypeOf(mock).send=async()=>{};});});

test('failed transactional intent makes zero adapter calls',async()=>{const f=fixture();f.deps.store.begin=()=>{throw new Error('synthetic persistence failure');};await assert.rejects(run(f));assert.equal(f.deps.adapter.sendCalls,0);});
test('concurrent calls reserve one approval and never duplicate effects',async()=>{const f=fixture();const results=await Promise.allSettled([run(f),run(f)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.deps.adapter.sendCalls,1);});
test('expired evidence or denied terms never reaches transport',async()=>{for(const mode of ['expired','terms']){const f=fixture();const p=join(f.privateDir,'review',f.batchId,'items',f.batch.items[0].id+'.json');const v=JSON.parse(readFileSync(p));if(mode==='expired')v.recipe.evidence.expiresAt=now;else v.recipe.evidence.terms.allowed=false;writeFileSync(p,JSON.stringify(v));await assert.rejects(run(f));assert.equal(f.deps.adapter.sendCalls,0);}});
test('edits racing intent reject locally with a terminal decision receipt',async()=>{const f=fixture();const begin=f.deps.store.begin.bind(f.deps.store);f.deps.store.begin=i=>{begin(i);writeFileSync(join(f.privateDir,'review',f.batchId,'review.md'),'synthetic tampering');};const r=await run(f);assert.equal(r.status,'rejected');assert.match(f.deps.store.get(r.executionId).receiptId,/^[a-f0-9]{64}$/);assert.equal(f.deps.adapter.sendCalls,0);});
test('approved payload contents are absent from execution results',async()=>{const f=fixture();const r=await run(f);assert.doesNotMatch(JSON.stringify(r),/example\.test|Synthetic Candidate|body|destination|principal/);assert.equal(f.deps.store.get(r.executionId).principal,'synthetic-operator');});

test('production host refuses worker-owned trust anchor even with valid self-signed artifact',async()=>{const f=fixture();const verificationConfigPath=join(f.privateDir,'synthetic-verify-key.json');writeFileSync(verificationConfigPath,JSON.stringify(authority),{mode:0o600});await assert.rejects(executeOdinApprovedBatch({privateDir:f.privateDir,batchId:f.batchId,send:true,approval:artifact(f.batch)},{...f.deps,verificationConfigPath}));assert.equal(f.deps.store.records.size,0);assert.equal(f.deps.adapter.sendCalls,0);});
