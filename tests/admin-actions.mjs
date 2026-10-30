// The guarded owner action contract and its fixture exemplar: dry run never writes, GET never executes, confirmation
// binds one exact scope with an expiry, every submission is re-checked against a fresh read (access, capability, pin,
// record versions, eligibility, budget, idempotency, lease), partial and unknown outcomes are reported as such, and a
// receipt carries no secret. No storage, network or production route is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ADMIN_ACTION_ERROR_CODES, ADMIN_ACTION_PREVIEW_STATES, ADMIN_ACTION_RECORD_OUTCOMES, ADMIN_ACTION_REFUSALS, ADMIN_ACTION_RUN_STATES, ADMIN_ACTION_SCHEMA_VERSION,
  checkSubmission, confirmAction, createRegistry, defineCapability, previewAction, receiptOf,
} from '../src/domain/admin-actions.js';
import {FIXTURE_CAPABILITY, createFixtureStore, executeFixtureAction, fixtureActionRequest, fixtureRegistry, issueFixtureConfirmation} from '../src/admin/actions-fixture.js';
import {evaluateDataHealth} from '../src/domain/data-health.js';

// Boundaries: the contract is pure; neither it nor the fixture reaches storage, network or a clock of its own; the Worker
// bundle does not include them and no Worker route serves them.
const contract = fs.readFileSync('src/domain/admin-actions.js', 'utf8');
const fixture = fs.readFileSync('src/admin/actions-fixture.js', 'utf8');
assert.doesNotMatch(contract, /\bfetch\b|BUCKET|cloudflare:|node:|\bimport\b|\brequire\(|Date\.now|new Date\(\)|Math\.random|\.prepare\(/);
assert.doesNotMatch(fixture, /\bfetch\b|BUCKET|env\.|cloudflare:|node:|\.prepare\(|localStorage|Authorization|Bearer|CF-Access/);
const build = fs.readFileSync('build.mjs', 'utf8');
const workerBundle = build.slice(build.indexOf("fs.writeFileSync('dist/server/index.js'"));
assert.equal(workerBundle.includes('admin-actions'), false, 'the Worker script does not carry the action contract');
assert.equal(workerBundle.includes('actions-fixture'), false, 'the Worker script does not carry the fixture executor');
assert.doesNotMatch(fs.readFileSync('src/worker.js', 'utf8'), /\/api\/admin\/actions|executeFixtureAction|previewAction/, 'no Worker route for actions');
assert.equal(ADMIN_ACTION_SCHEMA_VERSION, 1);

const NOW = '2026-10-30T12:00:00.000Z', at = ms => new Date(Date.parse(NOW) + ms).toISOString();
const PIN = '1|gen-1|ptr|prog|titles|people';
const issue = (id, eligible, completeness = 'complete', code = 'metadata_refresh') => ({id: 'metadata/incomplete/film:' + id, subject: {kind: 'film', id}, evidence: {completeness}, action: {suggested: eligible === true ? 'bounded_action' : 'investigate', code, eligible, reason: eligible === true ? 'eligible' : eligible === false ? 'generation_changed' : 'evidence_incomplete'}});
const seed = (extra = {}) => ({
  pin: PIN,
  records: [{id: 'film:a', version: 'v1', value: {title: 'A'}}, {id: 'film:b', version: 'v1', value: {title: 'B'}}, {id: 'film:c', version: 'v1', value: {title: 'C'}}, {id: 'film:d', version: 'v1', value: {title: 'D'}}],
  issues: [issue('film:a', true), issue('film:b', true), issue('film:c', false), issue('film:d', null)],
  ...extra,
});
const request = (extra = {}) => ({capability: 'fixture_metadata_refresh', version: 1, subject: {kind: 'film', id: 'metadata'}, pin: PIN, ...extra});
const registry = fixtureRegistry();
const owner = {owner: true};
const snapshot = store => JSON.stringify([...store.records.values()]);
let keyCounter = 0;
const key = () => 'idem-' + String(++keyCounter).padStart(12, '0');

// 1. Capability declarations are validated and versioned; the registry refuses duplicates.
assert.throws(() => defineCapability({id: 'Bad Id', version: 1, subjectKinds: ['film'], healthActionCode: 'x'}));
assert.throws(() => defineCapability({id: 'ok_id', version: 0, subjectKinds: ['film'], healthActionCode: 'x'}));
assert.throws(() => defineCapability({id: 'ok_id', version: 1, subjectKinds: [], healthActionCode: 'x'}));
assert.throws(() => defineCapability({id: 'ok_id', version: 1, subjectKinds: ['film'], healthActionCode: 'x', budget: {maxRecords: 51}}));
assert.throws(() => defineCapability({id: 'ok_id', version: 1, subjectKinds: ['film'], healthActionCode: 'x', compensation: {kind: 'magic'}}));
assert.throws(() => defineCapability({id: 'ok_id', version: 1, subjectKinds: ['film'], healthActionCode: 'x', confirmTtlMs: 2 * 3600000}));
assert.throws(() => createRegistry([FIXTURE_CAPABILITY, FIXTURE_CAPABILITY]));
assert.ok(Object.isFrozen(FIXTURE_CAPABILITY) && Object.isFrozen(FIXTURE_CAPABILITY.budget));
assert.equal(registry.get('fixture_metadata_refresh', 2), null, 'another version is another capability');

// 2. Dry run: eligible records only, the excluded ones with the model's reason, the budget, a stable scope, and no write.
let store = createFixtureStore(seed());
let before = snapshot(store);
let preview = previewAction(registry, request(), store.read(NOW));
assert.equal(preview.status, 'eligible');
assert.deepEqual(preview.affected.map(item => [item.id, item.version]), [['film:a', 'v1'], ['film:b', 'v1']]);
assert.deepEqual(preview.excluded, [{id: 'film:c', status: 'ineligible', reason: 'generation_changed'}, {id: 'film:d', status: 'unknown', reason: 'evidence_incomplete'}]);
assert.deepEqual(preview.budget, {records: 2, maxRecords: 5, writes: 2, externalCalls: 0});
assert.equal(preview.atomic, false, 'a multi-record action is never promised atomic');
assert.equal(preview.compensation.kind, 'restore_before_image');
assert.match(preview.scopeFingerprint, /^[0-9a-f]{8}$/);
assert.equal(previewAction(registry, request(), store.read(NOW)).scopeKey, preview.scopeKey, 'the same read gives the same scope');
assert.equal(snapshot(store), before, 'a preview writes nothing');
assert.deepEqual(store.writes, []);
assert.ok(ADMIN_ACTION_PREVIEW_STATES.includes(preview.status));

// 3. Preview states: unsupported capability, version or subject; stale pin; unknown observation; empty; ineligible; unknown evidence; budget.
assert.equal(previewAction(registry, request({capability: 'drop_everything'}), store.read(NOW)).status, 'unsupported');
assert.equal(previewAction(registry, request({version: 2}), store.read(NOW)).reason, 'unsupported_capability');
assert.equal(previewAction(registry, request({subject: {kind: 'person', id: 'x'}}), store.read(NOW)).reason, 'unsupported_subject');
assert.equal(previewAction(registry, {capability: 'fixture_metadata_refresh'}, store.read(NOW)).reason, 'invalid_request');
const stalePreview = previewAction(registry, request({pin: 'older-pin'}), store.read(NOW));
assert.equal(stalePreview.status, 'stale');assert.equal(stalePreview.currentPin, PIN);assert.deepEqual(stalePreview.affected, []);
assert.equal(previewAction(registry, request(), {pin: PIN, records: []}).status, 'unknown', 'no clock or issues is unknown');
assert.equal(previewAction(registry, request(), {pin: PIN, now: NOW, records: [], issues: []}).status, 'empty');
assert.equal(previewAction(registry, request({ids: ['film:c']}), store.read(NOW)).status, 'ineligible');
assert.equal(previewAction(registry, request({ids: ['film:d']}), store.read(NOW)).status, 'unknown');
assert.deepEqual(previewAction(registry, request({ids: ['film:a', 'film:zz']}), store.read(NOW)).excluded, [{id: 'film:zz', status: 'unknown', reason: 'record_not_read'}]);
const partialEvidence = createFixtureStore(seed({issues: [issue('film:a', true, 'partial')]}));
assert.equal(previewAction(registry, request({ids: ['film:a']}), partialEvidence.read(NOW)).status, 'ineligible', 'eligible on partial evidence is not eligible');
const otherCode = createFixtureStore(seed({issues: [issue('film:a', true, 'complete', 'poster_hydration')]}));
assert.equal(previewAction(registry, request({ids: ['film:a']}), otherCode.read(NOW)).excluded[0].reason, 'no_issue', 'an issue for another action does not qualify');
const many = createFixtureStore({pin: PIN, records: Array.from({length: 6}, (_, index) => ({id: 'film:' + index, version: 'v1'})), issues: Array.from({length: 6}, (_, index) => issue('film:' + index, true))});
const tooMany = previewAction(registry, request(), many.read(NOW));
assert.equal(tooMany.status, 'ineligible');assert.equal(tooMany.reason, 'budget_exceeded');
assert.equal(confirmAction(tooMany, {now: NOW, idempotencyKey: key(), accepted: true}).error, 'not_eligible');

// 4. Confirmation: only an eligible preview, only with an explicit acceptance and a well-formed key; it expires.
assert.deepEqual(confirmAction(preview, {now: NOW, idempotencyKey: key()}), {error: 'confirmation_missing'});
assert.deepEqual(confirmAction(preview, {now: NOW, idempotencyKey: 'short', accepted: true}), {error: 'invalid_request'});
assert.deepEqual(confirmAction(stalePreview, {now: NOW, idempotencyKey: key(), accepted: true}), {error: 'not_eligible'});
const confirmation = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
assert.equal(issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: confirmation.idempotencyKey, accepted: true}).error, 'idempotency_conflict', 'one key is issued once');
assert.equal(confirmation.expiresAt, at(10 * 60000));
assert.deepEqual(confirmation.ids, ['film:a', 'film:b']);
assert.equal(confirmation.scopeKey, preview.scopeKey);

// 5. Submission checks against a fresh read, each refusal before any write.
const fresh = store.read(at(1000));
assert.deepEqual(checkSubmission(registry, confirmation, fresh, {principal: {owner: false}, issued: confirmation}), {ok: false, refusal: 'access_denied'});
assert.deepEqual(checkSubmission(registry, confirmation, fresh, {}), {ok: false, refusal: 'access_denied'});
assert.deepEqual(checkSubmission(registry, null, fresh, {principal: owner, issued: confirmation}), {ok: false, refusal: 'confirmation_missing'});
assert.deepEqual(checkSubmission(registry, {...confirmation, capability: 'drop_everything'}, fresh, {principal: owner, issued: confirmation}), {ok: false, refusal: 'invalid_request'}, 'a capability that disagrees with the scope key is tampering');
{
  const foreign = createRegistry([defineCapability({id: 'other_action', version: 1, subjectKinds: ['film'], healthActionCode: 'metadata_refresh'})]);
  const foreignPreview = previewAction(foreign, request({capability: 'other_action'}), store.read(NOW));
  const foreignConfirmation = confirmAction(foreignPreview, {now: NOW, idempotencyKey: key(), accepted: true});
  assert.deepEqual(checkSubmission(registry, foreignConfirmation, fresh, {principal: owner, issued: foreignConfirmation}), {ok: false, refusal: 'unsupported_capability'});
}
assert.deepEqual(checkSubmission(registry, confirmation, store.read(at(10 * 60000 + 1)), {principal: owner, issued: confirmation}), {ok: false, refusal: 'confirmation_expired'});
assert.equal(checkSubmission(registry, confirmation, store.read(at(10 * 60000)), {principal: owner, issued: confirmation}).ok, true, 'exactly at the expiry is still valid');
assert.deepEqual(checkSubmission(registry, confirmation, {...fresh, pin: 'new-pin'}, {principal: owner, issued: confirmation}), {ok: false, refusal: 'stale_pin'});
assert.deepEqual(checkSubmission(registry, confirmation, {...fresh, records: fresh.records.map(record => record.id === 'film:b' ? {...record, version: 'v2'} : record)}, {principal: owner, issued: confirmation}), {ok: false, refusal: 'record_changed'});
assert.deepEqual(checkSubmission(registry, confirmation, {...fresh, records: fresh.records.filter(record => record.id !== 'film:a')}, {principal: owner, issued: confirmation}), {ok: false, refusal: 'record_changed'});
assert.deepEqual(checkSubmission(registry, confirmation, {...fresh, issues: [issue('film:a', true), issue('film:b', false)]}, {principal: owner, issued: confirmation}), {ok: false, refusal: 'eligibility_changed'});
assert.deepEqual(checkSubmission(registry, {...confirmation, idempotencyKey: 'x'}, fresh, {principal: owner, issued: confirmation}), {ok: false, refusal: 'invalid_request'});
assert.deepEqual(checkSubmission(registry, confirmation, fresh, {principal: owner}), {ok: false, refusal: 'confirmation_missing'}, 'a confirmation the issuer does not hold is refused');
assert.equal(snapshot(store), before, 'refused checks write nothing');

// 6. Transport: GET only previews, POST only executes; GET can never execute; access is checked first.
let response = await fixtureActionRequest(store, registry, {method: 'GET', path: '/execute', body: confirmation, principal: owner, now: at(1000)});
assert.equal(response.status, 405);assert.deepEqual(store.writes, [], 'a GET to execute writes nothing');
response = await fixtureActionRequest(store, registry, {method: 'GET', path: '/preview', body: request(), principal: owner, now: at(1000)});
assert.equal(response.status, 200);assert.equal(response.body.status, 'eligible');assert.deepEqual(store.writes, []);
response = await fixtureActionRequest(store, registry, {method: 'POST', path: '/preview', body: request(), principal: owner, now: at(1000)});
assert.equal(response.status, 405);
response = await fixtureActionRequest(store, registry, {method: 'POST', path: '/execute', body: confirmation, principal: {owner: false}, now: at(1000)});
assert.equal(response.status, 403);assert.deepEqual(store.writes, []);
response = await fixtureActionRequest(store, registry, {method: 'GET', path: '/other', principal: owner});
assert.equal(response.status, 404);

// 7. Execution: CAS per record, receipt, idempotent replay, conflicting reuse of a key.
response = await fixtureActionRequest(store, registry, {method: 'POST', path: '/execute', body: confirmation, principal: owner, now: at(1000)});
assert.equal(response.status, 200);
let receipt = response.body;
assert.equal(receipt.state, 'succeeded');assert.equal(receipt.replay, false);
assert.deepEqual(receipt.outcomes, [{id: 'film:a', outcome: 'written'}, {id: 'film:b', outcome: 'written'}]);
assert.deepEqual(store.writes, ['film:a', 'film:b']);
assert.equal(store.records.get('film:c').value.refreshed, undefined, 'ineligible records are untouched');
assert.notEqual(store.records.get('film:a').version, 'v1', 'a write bumps the version');
assert.deepEqual(store.beforeImages.get(confirmation.idempotencyKey + '/film:a'), {title: 'A'}, 'the before-image is kept for compensation');
assert.ok(ADMIN_ACTION_RUN_STATES.includes(receipt.state));
for (const entry of receipt.outcomes) assert.ok(ADMIN_ACTION_RECORD_OUTCOMES.includes(entry.outcome));
const replayed = await fixtureActionRequest(store, registry, {method: 'POST', path: '/execute', body: confirmation, principal: owner, now: at(2000)});
assert.equal(replayed.body.replay, true);assert.deepEqual(store.writes, ['film:a', 'film:b'], 'a replay writes nothing');
assert.equal(replayed.body.state, 'succeeded');
const reused = await fixtureActionRequest(store, registry, {method: 'POST', path: '/execute', body: {...confirmation, scopeKey: confirmation.scopeKey.replace('v1', 'v9')}, principal: owner, now: at(2000)});
assert.equal(reused.status, 409);assert.equal(reused.body.refusal, 'idempotency_conflict');
// After the run the old confirmation is stale for a new key: the versions it names changed.
const again = await fixtureActionRequest(store, registry, {method: 'POST', path: '/execute', body: {...confirmation, idempotencyKey: key()}, principal: owner, now: at(2000)});
assert.equal(again.status, 400);assert.equal(again.body.refusal, 'confirmation_missing', 'a key the issuer never issued is refused');assert.deepEqual(store.writes, ['film:a', 'film:b']);
const reissued = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
const afterRun = await fixtureActionRequest(store, registry, {method: 'POST', path: '/execute', body: reissued, principal: owner, now: at(2000)});
assert.equal(afterRun.status, 409);assert.equal(afterRun.body.refusal, 'record_changed', 'the old scope names versions the run replaced');assert.deepEqual(store.writes, ['film:a', 'film:b']);

// 8. Concurrent submits with one key run once; concurrent submits with different keys meet the lease.
store = createFixtureStore(seed());
preview = previewAction(registry, request(), store.read(NOW));
const shared = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
const other = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
let release;
const gate = new Promise(resolve => {release = resolve;});
const slowApply = async record => {await gate; return {...record.value, refreshed: true};};
const first = executeFixtureAction(store, registry, shared, {principal: owner, now: at(1000), apply: slowApply});
const second = executeFixtureAction(store, registry, shared, {principal: owner, now: at(1000), apply: slowApply});
const otherKey = await executeFixtureAction(store, registry, other, {principal: owner, now: at(1000), apply: slowApply});
assert.equal(otherKey.receipt.refusal, 'lease_held', 'another key cannot run beside a held lease');
release();
const [firstResult, secondResult] = await Promise.all([first, second]);
assert.equal(firstResult.replay, false);assert.equal(secondResult.replay, true);
assert.deepEqual(store.writes, ['film:a', 'film:b'], 'two concurrent submits of one key write once');
assert.equal(store.lease, null, 'the lease is released');

// 9. Partial, unknown and aborted outcomes; a record changed under the run is skipped, not overwritten.
store = createFixtureStore(seed());
preview = previewAction(registry, request(), store.read(NOW));
let confirmed = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
let result = await executeFixtureAction(store, registry, confirmed, {principal: owner, now: at(1000), apply: async record => {if (record.id === 'film:b') throw Object.assign(new Error('provider said no'), {code: 'provider_error'}); return {...record.value, refreshed: true};}});
assert.equal(result.receipt.state, 'partial');
assert.deepEqual(result.receipt.outcomes, [{id: 'film:a', outcome: 'written'}, {id: 'film:b', outcome: 'failed', error: 'provider_error'}]);
assert.deepEqual(result.receipt.retry.retryable, ['film:b']);
assert.equal(result.receipt.atomic, false);
store = createFixtureStore(seed());
preview = previewAction(registry, request(), store.read(NOW));
confirmed = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
result = await executeFixtureAction(store, registry, confirmed, {principal: owner, now: at(1000), apply: async record => {if (record.id === 'film:a') throw Object.assign(new Error('timeout'), {unknown: true, code: 'timeout'}); return {...record.value, refreshed: true};}});
assert.equal(result.receipt.state, 'unknown', 'one unknown write makes the run unknown');
assert.deepEqual(result.receipt.retry.retryable, [], 'an unknown outcome is never retried blindly');
assert.match(result.receipt.retry.note, /read the records again/);
store = createFixtureStore(seed());
preview = previewAction(registry, request(), store.read(NOW));
confirmed = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
const controller = new AbortController();
result = await executeFixtureAction(store, registry, confirmed, {principal: owner, now: at(1000), signal: controller.signal, apply: async record => {controller.abort(); return {...record.value, refreshed: true};}});
assert.equal(result.receipt.state, 'aborted');
assert.deepEqual(result.receipt.outcomes.map(entry => entry.outcome), ['written', 'not_attempted']);
assert.deepEqual(result.receipt.retry.retryable, ['film:b']);
store = createFixtureStore(seed());
preview = previewAction(registry, request(), store.read(NOW));
confirmed = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
result = await executeFixtureAction(store, registry, confirmed, {principal: owner, now: at(1000), apply: async record => {if (record.id === 'film:a') store.records.get('film:b').version = 'changed-elsewhere'; return {...record.value, refreshed: true};}});
assert.equal(result.receipt.state, 'partial');
assert.deepEqual(result.receipt.outcomes.map(entry => entry.outcome), ['written', 'skipped_changed']);
assert.equal(store.records.get('film:b').value.refreshed, undefined);

// 10. Receipts carry no secret or identity, and the refusal vocabulary is closed.
const secretPrincipal = {owner: true, email: 'owner@example.com', jwt: 'eyJ.secret.token'};
store = createFixtureStore(seed());
preview = previewAction(registry, request(), store.read(NOW));
confirmed = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
result = await executeFixtureAction(store, registry, confirmed, {principal: secretPrincipal, now: at(1000)});
const text = JSON.stringify(result.receipt);
assert.doesNotMatch(text, /owner@example\.com|eyJ|secret|token/i);
assert.equal(result.receipt.audit.actor, 'owner');
assert.equal(Object.hasOwn(result.receipt, 'scopeKey'), false, 'the receipt names the scope by fingerprint, not by the full key');
for (const refusal of ['access_denied', 'confirmation_expired', 'stale_pin', 'record_changed', 'eligibility_changed', 'idempotency_conflict', 'lease_held', 'budget_exceeded']) assert.ok(ADMIN_ACTION_REFUSALS.includes(refusal), refusal);
assert.equal(receiptOf({confirmation: confirmed, refusal: 'stale_pin', outcomes: []}).state, 'refused');
assert.equal(receiptOf({confirmation: confirmed, capability: FIXTURE_CAPABILITY, outcomes: []}).state, 'failed', 'no outcome is never success');

// 11. The contract consumes the real data health issues: an evaluated eligible metadata issue makes the preview eligible.
const evaluated = evaluateDataHealth({
  now: NOW, coverage: {films: 'complete'}, published: {programmeRunId: 'gen-1', phase: 'published', publishedAt: at(-3600000), observedAt: NOW},
  films: [{id: 'film:m', programmeRunId: 'gen-1', observedAt: NOW, identity: {status: 'resolved'}, metadata: {status: 'missing'}, localization: {status: 'reviewed'}, localizationConflicts: [], externalIds: [], fingerprint: {status: 'current'}, prediction: {status: 'current'}}],
});
const modelStore = createFixtureStore({pin: PIN, records: [{id: 'film:m', version: 'v1'}], issues: evaluated.issues});
const modelPreview = previewAction(registry, request(), modelStore.read(NOW));
assert.equal(modelPreview.status, 'eligible');
assert.deepEqual(modelPreview.affected.map(item => item.id), ['film:m']);
// 12. Review fixes. (a) CAS and fence are re-checked at commit time: a record changed, or the lease lost, while `apply`
// is suspended is never written, and the receipt says so.
{
  store = createFixtureStore(seed());
  preview = previewAction(registry, request(), store.read(NOW));
  const raced = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
  const result = await executeFixtureAction(store, registry, raced, {principal: owner, now: at(1000), apply: async record => {
    if (record.id === 'film:a') store.records.get('film:a').version = 'changed-during-apply';
    return {...record.value, refreshed: true};
  }});
  assert.deepEqual(result.receipt.outcomes, [{id: 'film:a', outcome: 'skipped_changed', error: 'conflict'}, {id: 'film:b', outcome: 'written'}]);
  assert.equal(store.records.get('film:a').value.refreshed, undefined, 'the record changed during apply is not overwritten');
  assert.equal(store.records.get('film:a').version, 'changed-during-apply');
  assert.deepEqual(store.writes, ['film:b']);
  assert.equal(result.receipt.state, 'partial');
}
{
  store = createFixtureStore(seed());
  preview = previewAction(registry, request(), store.read(NOW));
  const revoked = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
  const result = await executeFixtureAction(store, registry, revoked, {principal: owner, now: at(1000), apply: async record => {
    store.revokeLease();
    return {...record.value, refreshed: true};
  }});
  assert.deepEqual(store.writes, [], 'a lease lost during apply writes nothing');
  assert.deepEqual(result.receipt.outcomes, [{id: 'film:a', outcome: 'not_attempted', error: 'fence_lost'}, {id: 'film:b', outcome: 'not_attempted', error: 'fence_lost'}]);
  assert.equal(result.receipt.state, 'aborted');
  assert.deepEqual(result.receipt.retry.retryable, ['film:a', 'film:b']);
  assert.equal(store.lease?.key ?? null, null, 'the revoked lease is not released by the old holder as if it were its own');
}

// (b) An untrusted confirmation fails closed: malformed shapes are `invalid_request`, an edited expiry is a mismatch with
// the issued record, and nothing throws or writes.
{
  store = createFixtureStore(seed());
  preview = previewAction(registry, request(), store.read(NOW));
  const good = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
  const fresh2 = store.read(at(1000));
  const check = (submitted, issued = good) => {
    let result;
    assert.doesNotThrow(() => {result = checkSubmission(registry, submitted, fresh2, {principal: owner, issued});});
    return result.refusal ?? 'ok';
  };
  const scope = JSON.parse(good.scopeKey);
  const variants = {
    'missing ids': {...good, ids: undefined},
    'ids not an array': {...good, ids: 'film:a'},
    'empty ids': {...good, ids: []},
    'duplicate ids': {...good, ids: ['film:a', 'film:a']},
    'ids not matching the scope': {...good, ids: ['film:b', 'film:a']},
    'malformed JSON scope key': {...good, scopeKey: '{"capability":'},
    'scope key not canonical': {...good, scopeKey: JSON.stringify(scope, null, 1)},
    'scope key array': {...good, scopeKey: '[]'},
    'scope with an extra field': {...good, scopeKey: JSON.stringify({...scope, extra: 1})},
    'scope records not objects': {...good, scopeKey: '{"capability":"fixture_metadata_refresh","pin":"' + PIN + '","records":["film:a","film:b"],"subject":{"id":"metadata","kind":"film"},"version":1}'},
    'scope of another pin': {...good, scopeKey: good.scopeKey.replace(PIN, 'other')},
    'subject not an object': {...good, subject: 'film'},
    'version as text': {...good, version: '1'},
    'unknown field': {...good, extra: true},
    'fingerprint edited': {...good, scopeFingerprint: '00000000'},
    'expiry unparseable': {...good, expiresAt: 'tomorrow'},
    'huge scope key': {...good, scopeKey: 'x'.repeat(20001)},
  };
  for (const [name, submitted] of Object.entries(variants)) assert.equal(check(submitted), 'invalid_request', name);
  for (const value of [42, 'text', [], true]) assert.equal(check(value), 'invalid_request', 'confirmation ' + JSON.stringify(value));
  assert.equal(check(null), 'confirmation_missing');
  const extended = {...good, expiresAt: at(365 * 86400000)};
  assert.equal(check(extended), 'confirmation_mismatch', 'an extended expiry does not match the issued record');
  assert.equal(checkSubmission(registry, extended, store.read(at(11 * 60000)), {principal: owner, issued: good}).refusal, 'confirmation_mismatch');
  assert.equal(checkSubmission(registry, good, store.read(at(11 * 60000)), {principal: owner, issued: good}).refusal, 'confirmation_expired', 'the issued expiry is the one enforced');
  assert.equal(check(good, {...good, expiresAt: 'bad'}), 'confirmation_missing', 'a malformed issued record is no issuance');
  assert.equal(check(good), 'ok');
  for (const submitted of [...Object.values(variants), extended]) {
    const response = await fixtureActionRequest(store, registry, {method: 'POST', path: '/execute', body: submitted, principal: owner, now: at(1000)});
    assert.equal(response.body.state, 'refused');
    assert.ok(['invalid_request', 'confirmation_mismatch', 'confirmation_missing', 'idempotency_conflict'].includes(response.body.refusal), response.body.refusal);
  }
  assert.deepEqual(store.writes, [], 'no malformed or extended confirmation writes anything');
  // A confirmation whose ids omit an eligible record is a scope the preview never issued: refused, not trimmed.
  const fresh3 = store.read(at(1000));
  const unissued = confirmAction(previewAction(registry, request({ids: ['film:a']}), fresh3), {now: NOW, idempotencyKey: key(), accepted: true});
  assert.equal(checkSubmission(registry, unissued, fresh3, {principal: owner, issued: good}).refusal, 'confirmation_mismatch');
}

// (c) Capability numbers are bounded integers: negative, fractional, infinite, NaN and textual values are rejected.
{
  const base = {id: 'bounded', version: 1, subjectKinds: ['film'], healthActionCode: 'metadata_refresh'};
  const bad = [
    {budget: {maxRecords: 0}}, {budget: {maxRecords: 1.5}}, {budget: {maxRecords: '5'}},
    {budget: {maxWritesPerRecord: -1}}, {budget: {maxWritesPerRecord: 0}}, {budget: {maxWritesPerRecord: 1.5}}, {budget: {maxWritesPerRecord: Infinity}}, {budget: {maxWritesPerRecord: NaN}}, {budget: {maxWritesPerRecord: '1'}}, {budget: {maxWritesPerRecord: 11}},
    {budget: {externalCallsPerRecord: -1}}, {budget: {externalCallsPerRecord: 0.5}}, {budget: {externalCallsPerRecord: Infinity}}, {budget: {externalCallsPerRecord: NaN}}, {budget: {externalCallsPerRecord: '0'}}, {budget: {externalCallsPerRecord: 11}},
    {retry: {maxAttempts: 0}}, {retry: {maxAttempts: 6}}, {retry: {backoffMs: -1}}, {retry: {backoffMs: 1.5}}, {retry: {backoffMs: Infinity}}, {retry: {backoffMs: NaN}}, {retry: {backoffMs: '60000'}}, {retry: {backoffMs: 8 * 86400000}},
    {confirmTtlMs: 999}, {confirmTtlMs: Infinity}, {confirmTtlMs: '600000'},
    {budget: 'big'}, {retry: 5}, {subjectKinds: ['film', '']},
  ];
  for (const extra of bad) assert.throws(() => defineCapability({...base, ...extra}), /invalid capability/, JSON.stringify(extra, (key, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value));
  const edge = defineCapability({...base, budget: {maxRecords: 50, maxWritesPerRecord: 10, externalCallsPerRecord: 0}, retry: {maxAttempts: 5, backoffMs: 7 * 86400000}, confirmTtlMs: 3600000});
  assert.deepEqual(edge.budget, {maxRecords: 50, maxWritesPerRecord: 10, externalCallsPerRecord: 0});
  assert.equal(edge.retry.backoffMs, 7 * 86400000);
  const defaults = defineCapability(base);
  assert.deepEqual(defaults.budget, {maxRecords: 10, maxWritesPerRecord: 1, externalCallsPerRecord: 0});
  assert.equal(defaults.retry.backoffMs, 0);
}

// (d) Receipt errors are codes of a closed vocabulary: a secret in an exception message never reaches the receipt.
{
  store = createFixtureStore(seed());
  preview = previewAction(registry, request(), store.read(NOW));
  const leaky = issueFixtureConfirmation(store, preview, {now: NOW, idempotencyKey: key(), accepted: true});
  const secret = 'Bearer sk-live-FAKE0123456789 at https://user:p4ssw0rd@provider.example/v1?token=abc owner@example.com';
  const result = await executeFixtureAction(store, registry, leaky, {principal: {owner: true, email: 'owner@example.com'}, now: at(1000), apply: async record => {
    if (record.id === 'film:a') throw new Error(secret);
    throw Object.assign(new Error(secret), {code: secret});
  }});
  const text = JSON.stringify(result.receipt);
  for (const fragment of ['Bearer', 'sk-live', 'p4ssw0rd', 'user:', 'provider.example', 'token=', 'owner@example.com']) assert.equal(text.includes(fragment), false, fragment);
  assert.deepEqual(result.receipt.outcomes, [{id: 'film:a', outcome: 'failed', error: 'internal_error'}, {id: 'film:b', outcome: 'failed', error: 'internal_error'}]);
  assert.equal(receiptOf({confirmation: leaky, capability: FIXTURE_CAPABILITY, outcomes: [{id: 'film:a', outcome: 'failed', error: secret}]}).outcomes[0].error, 'internal_error');
  assert.equal(receiptOf({confirmation: leaky, capability: FIXTURE_CAPABILITY, outcomes: [{id: 'film:a', outcome: 'failed', error: 'rate_limited'}]}).outcomes[0].error, 'rate_limited');
  assert.equal(receiptOf({confirmation: {...leaky, subject: {kind: 'film', id: secret}}, refusal: 'stale_pin', outcomes: []}).subject, null, 'an invalid confirmation echoes nothing');
  assert.equal(receiptOf({confirmation: leaky, refusal: secret, outcomes: []}).refusal, 'invalid_request', 'an unknown refusal is never echoed');
  for (const code of ['provider_error', 'timeout', 'rate_limited', 'conflict', 'fence_lost', 'validation_error', 'storage_error', 'aborted', 'internal_error']) assert.ok(ADMIN_ACTION_ERROR_CODES.includes(code), code);
}

// (e) Eligibility matches the subject kind as well as the id: an observation never lends its eligibility to a film.
{
  const crossKind = createFixtureStore({pin: PIN, records: [{id: 'shared-id', version: 'v1'}], issues: [
    {id: 'identity/stuck/observation:shared-id', subject: {kind: 'observation', id: 'shared-id'}, evidence: {completeness: 'complete'}, action: {suggested: 'bounded_action', code: 'metadata_refresh', eligible: true, reason: 'eligible'}},
    {id: 'metadata/incomplete/film:shared-id', subject: {kind: 'film', id: 'shared-id'}, evidence: {completeness: 'complete'}, action: {suggested: 'investigate', code: 'metadata_refresh', eligible: false, reason: 'generation_changed'}},
  ]});
  const crossPreview = previewAction(registry, request(), crossKind.read(NOW));
  assert.equal(crossPreview.status, 'ineligible');
  assert.deepEqual(crossPreview.excluded, [{id: 'shared-id', status: 'ineligible', reason: 'generation_changed'}]);
  const onlyObservation = createFixtureStore({pin: PIN, records: [{id: 'shared-id', version: 'v1'}], issues: [crossKind.issues[0]]});
  assert.deepEqual(previewAction(registry, request(), onlyObservation.read(NOW)).excluded, [{id: 'shared-id', status: 'ineligible', reason: 'no_issue'}], 'an observation issue does not qualify a film');
  const kindedRecord = createFixtureStore({pin: PIN, records: [{id: 'film:a', version: 'v1'}], issues: [issue('film:a', true)]});
  const read = kindedRecord.read(NOW);
  read.records[0].kind = 'observation';
  assert.deepEqual(previewAction(registry, request(), read).excluded, [{id: 'film:a', status: 'unsupported', reason: 'subject_kind_differs'}]);
}
console.log('Admin actions: capability bounds, preview, issued confirmation, fail-closed submission checks, GET/POST transport, commit-time CAS and fence, idempotency, concurrency, partial, unknown, abort, error codes and subject kinds passed');
