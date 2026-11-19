// AIR-132 / ADR 0178: the owner revoke page /admin/identity/revoke. Static boundary, the pure view (escaping, wording), and the
// client (one GET, two POSTs, no retry). The page script runs in a real browser in the PR's written Visual QA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Identity from '../src/domain/discovery-identity-review.js';

const html = fs.readFileSync('public/admin-identity-revoke.html', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
assert.match(html, /<script src="\/admin-identity-revoke\.js"><\/script>/);
assert.doesNotMatch(html, /admin-limbo\.js|admin-identity\.js/, 'it shares no bundle with the Limbo page or the read-only queue');
assert.doesNotMatch(html, /\son[a-z]+=|<script>[^<]/i, 'no inline handler or script');
assert.match(html, /<a href="\/admin\/identity" data-return-carry>Идентификация<\/a>/, 'the queue is one link away');
assert.match(html, /id="revoke-confirm-form"[^>]*hidden/, 'confirmation stays hidden until a preview says it may be used');
assert.match(html, /id="supersede-form"[^>]*hidden/, 'the replace form stays hidden until a preview says the action can be replaced');
assert.doesNotMatch(html, /<form[^>]*supersede[^>]*method=/i, 'no native form post');
assert.match(build, /assets\['\/admin\/identity\/revoke'\]=\{body:fs\.readFileSync\('public\/admin-identity-revoke\.html'/);
assert.match(build, /assets\['\/admin-identity-revoke\.js'\]=\{body:bundleAdmin\(\[fs\.readFileSync\('src\/admin\/identity-revoke-client\.js'/);
for (const own of ['/admin-limbo.js', '/admin-identity.js']) {
  const start = build.indexOf("assets['" + own + "']");
  assert.ok(!build.slice(start, build.indexOf('\n', start)).includes('identity-revoke'), own + ' holds no revoke file');
}

const calls = [];
const context = vm.createContext({URLSearchParams, JSON, Math, Array, Uint8Array, String, crypto: webcrypto, globalThis: {}});
for (const file of ['src/admin/identity-revoke-client.js', 'src/admin/identity-revoke-view.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
const run = code => vm.runInContext(code, context);
const reply = (status, body) => ({ok: status < 400, status, json: async () => body});
const fetchWith = answer => async (url, init) => { calls.push({url, init}); return answer; };
Object.assign(context, {reply, fetchWith, calls});

// The preview is a GET with no body and no action header.
let result = await run("revokePreviewGet('тихий|2001', 'req-0123456789abcdef', {fetch: fetchWith(reply(200, {available: true}))})");
assert.equal(result.ok, true);
assert.equal(calls[0].url, '/api/admin/discovery-recovery/revoke-preview?key=' + encodeURIComponent('тихий|2001') + '&requestId=req-0123456789abcdef');
assert.equal(calls[0].init.method, undefined);
assert.equal(calls[0].init.body, undefined);
// The two writes carry the owner action header, same-origin credentials and a fresh key, and are sent once.
calls.length = 0;
result = await run("revokeConfirmPost({key: 'k', pin: 'D1.x', requestId: 'req-0123456789abcdef', basis: 'b'}, {fetch: fetchWith(reply(200, {confirmation: {a: 1}}))})");
assert.equal(calls.length, 1);
assert.equal(calls[0].url, '/api/admin/discovery-recovery/revoke-confirm');
assert.equal(calls[0].init.method, 'POST');
assert.equal(calls[0].init.headers['X-IPTV-Admin-Action'], 'discovery_identity_correct');
assert.equal(calls[0].init.credentials, 'same-origin');
const sent = JSON.parse(calls[0].init.body);
assert.equal(sent.accepted, true);
assert.match(sent.idempotencyKey, /^revoke-[0-9a-f]{36}$/);
assert.match(sent.idempotencyKey, /^[A-Za-z0-9_-]{16,80}$/, 'the key satisfies the server pattern');
calls.length = 0;
await run("revokeExecutePost({capability: 'discovery_identity_revoke'}, {fetch: fetchWith(reply(409, {refusal: 'in_progress', state: 'unknown'}))})");
assert.equal(calls.length, 1, 'an unknown outcome is not retried');
assert.equal(JSON.parse(calls[0].init.body).confirmation.capability, 'discovery_identity_revoke');
// A supersede uses the two identity routes with the same header, names the saved action it replaces and is sent once.
calls.length = 0;
await run("supersedeConfirmPost({key: 'k', pin: 'D1.x', effect: 'reject', tmdbId: '41', basis: 'b', supersedes: {requestId: 'req-0123456789abcdef'}}, {fetch: fetchWith(reply(200, {confirmation: {a: 1}}))})");
assert.equal(calls.length, 1);
assert.equal(calls[0].url, '/api/admin/discovery-recovery/identity-confirm');
assert.equal(calls[0].init.headers['X-IPTV-Admin-Action'], 'discovery_identity_correct');
const supBody = JSON.parse(calls[0].init.body);
assert.deepEqual([supBody.effect, supBody.tmdbId, supBody.supersedes.requestId, supBody.accepted], ['reject', '41', 'req-0123456789abcdef', true]);
assert.match(supBody.idempotencyKey, /^revoke-[0-9a-f]{36}$/);
calls.length = 0;
await run("supersedeExecutePost({capability: 'discovery_identity_correct'}, {fetch: fetchWith(reply(409, {refusal: 'old_action_not_effective'}))})");
assert.equal(calls.length, 1, 'a refused or unknown supersede is not retried');
assert.equal(calls[0].url, '/api/admin/discovery-recovery/identity-correct');
assert.equal(run("supersedeReasonText('old_action_not_effective')").startsWith('Это действие уже не действует'), true);
assert.match(run("supersedeReasonText('year_conflict')"), /код: year_conflict/, 'an identity reason without copy is shown by code, not hidden');
// Refusals and a lost connection are mapped, never thrown, never retried.
result = await run("revokeExecutePost({}, {fetch: fetchWith(reply(409, {refusal: 'record_changed'}))})");
assert.deepEqual([result.ok, result.error], [false, 'record_changed']);
calls.length = 0;
result = await run("revokeExecutePost({}, {fetch: async () => { throw new Error('offline'); }})");
assert.deepEqual([result.ok, result.error, result.status], [false, 'network', 0]);

// The view: every reason the domain and the routes can answer has wording; stored text is escaped.
const copy = run('REVOKE_REASON_COPY');
for (const reason of Identity.DISCOVERY_REVOKE_REASONS) assert.equal(typeof copy[reason], 'string', reason);
for (const refusal of ['not_authoritative', 'stale_pin', 'confirmation_missing', 'confirmation_expired', 'confirmation_mismatch', 'idempotency_conflict', 'revoke_schema_not_ready', 'record_changed', 'lease_held', 'in_progress', 'access_denied', 'storage_unavailable', 'network']) assert.equal(typeof copy[refusal], 'string', refusal);
assert.equal(run("revokeReasonText('nope')"), 'Отзыв сейчас недоступен.');
const hostile = {available: true, reason: 'eligible', original: {requestId: '<img src=x onerror=alert(1)>', state: 'receipt', effect: 'assign', tmdbId: '41', basis: '"><script>x</script>'}, versions: [{revision: 2, writer: '<b>w</b>', at: 't', status: 's'}], current: {status: 'verified', tmdbId: '41', rejectedTmdbIds: [], revokedOwnerAssign: null}, application: {shows: 'clears_assigned_rows_and_fences_id', fence: {tmdbId: '41'}}};
context.hostile = hostile;
const painted = run('revokePreviewHtml(hostile)');
assert.doesNotMatch(painted, /<img|<script/, 'nothing stored is rendered as markup');
assert.ok(painted.includes('&lt;img src=x onerror=alert(1)&gt;') && painted.includes('&lt;b&gt;w&lt;/b&gt;') && painted.includes('&quot;&gt;&lt;script&gt;'), 'stored text is escaped, not dropped');
assert.match(painted, /Можно отозвать/);
assert.match(painted, /не будет подтверждён заново/, 'the fence is stated');
context.refused = {available: false, reason: 'old_action_not_effective', original: null, versions: []};
assert.match(run('revokePreviewHtml(refused)'), /Отозвать нельзя\.<\/b> Это действие уже не действует/);
assert.match(run('revokeVersionsHtml([])'), /пуста/, 'an empty history is stated');
assert.equal(run("revokeReceiptText({receipt: {decisionHash: 'abcdef0123456789'}, replayed: true})").startsWith('Это повтор'), true);
assert.equal(run('revokeReceiptText(null)'), '');
// The page script on a minimal fake DOM: only one staged mutation at a time (review of PR 796). Prepare a supersede after the
// revoke form was filled and ticked: the revoke confirm button must be disabled, rvConfirm must refuse, and no second request goes out.
{
  const elements = new Map();
  const make = id => {
    const listeners = new Map();
    const element = {id, hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', dataset: {}, focus() {}, setAttribute() {}, addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      fire(type) { for (const fn of listeners.get(type) || []) fn({preventDefault() {}, target: element}); }};
    elements.set(id, element);
    return element;
  };
  for (const id of ['revoke-form', 'revoke-key', 'revoke-request', 'revoke-preview-button', 'revoke-loading', 'revoke-error', 'revoke-preview', 'revoke-confirm-form', 'revoke-basis', 'revoke-accept', 'revoke-confirm-button', 'revoke-execute-button', 'revoke-cancel-button', 'supersede-form', 'supersede-effect', 'supersede-id', 'supersede-basis', 'supersede-accept', 'supersede-confirm-button', 'supersede-execute-button', 'supersede-cancel-button', 'revoke-receipt']) make(id);
  const requests = [];
  const answer = body => ({ok: true, status: 200, json: async () => body});
  const preview = {key: 'k|2001', requestId: 'req-0123456789abcdef', available: true, reason: 'eligible', pin: 'D1.' + 'a'.repeat(32), original: {requestId: 'req-0123456789abcdef', state: 'receipt', effect: 'assign', tmdbId: '41'}, versions: [], current: {status: 'verified'}, application: {shows: 'clears_assigned_rows_and_fences_id', fence: {tmdbId: '41'}}};
  const page = vm.createContext({URLSearchParams, JSON, Math, Array, Uint8Array, String, Promise, crypto: webcrypto, location: {search: ''},
    document: {querySelector: selector => elements.get(selector.slice(1)) || null},
    fetch: async (url, init) => { requests.push(String(url).split('/').pop().split('?')[0]); return answer(String(url).includes('revoke-preview') ? preview : {confirmation: {capability: 'x', idempotencyKey: 'revoke-staged-0000001'}}); }});
  vm.runInContext(['src/admin/identity-revoke-client.js', 'src/admin/identity-revoke-view.js', 'public/admin-identity-revoke.js'].map(file => fs.readFileSync(file, 'utf8')).join('\n'), page);
  const el = id => elements.get(id);
  el('revoke-key').value = 'k|2001'; el('revoke-request').value = 'req-0123456789abcdef';
  el('revoke-form').fire('submit');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['revoke-preview']);
  assert.equal(el('supersede-form').hidden, false, 'the replace form is offered for an eligible preview');
  // Fill and tick the revoke form first, then prepare a supersede.
  el('revoke-basis').value = 'wrong film'; el('revoke-basis').fire('input');
  el('revoke-accept').checked = true; el('revoke-accept').fire('change');
  assert.equal(el('revoke-confirm-button').disabled, false, 'the revoke can be confirmed on its own');
  el('supersede-id').value = '41'; el('supersede-id').fire('input');
  el('supersede-basis').value = 'better id'; el('supersede-basis').fire('input');
  el('supersede-accept').checked = true; el('supersede-accept').fire('change');
  el('supersede-form').fire('submit');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['revoke-preview', 'identity-confirm'], 'the supersede is staged');
  assert.equal(el('supersede-execute-button').hidden, false);
  assert.equal(el('revoke-confirm-button').disabled, true, 'while a replacement is staged the revoke cannot be confirmed');
  assert.equal(el('revoke-execute-button').hidden, true, 'only one execute path is shown');
  // Even a forced submit of the revoke form issues nothing.
  el('revoke-confirm-form').fire('submit');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['revoke-preview', 'identity-confirm'], 'no second confirmation while one mutation is staged');
  // Cancelling the replacement gives the revoke back, and then a revoke staged blocks the replacement the same way.
  el('supersede-cancel-button').fire('click');
  assert.equal(el('revoke-confirm-button').disabled, false, 'the revoke form kept its own basis and box, so the revoke can be confirmed again');
  el('revoke-confirm-form').fire('submit');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['revoke-preview', 'identity-confirm', 'revoke-confirm'], 'the revoke is staged after the replacement was cancelled');
  assert.equal(el('supersede-confirm-button').disabled, true, 'while a revoke is staged the replacement cannot be confirmed');
  el('supersede-accept').checked = true; el('supersede-accept').fire('change');
  el('supersede-form').fire('submit');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['revoke-preview', 'identity-confirm', 'revoke-confirm'], 'no replacement while a revoke is staged');
}
console.log('admin-identity-revoke-page: ok');
