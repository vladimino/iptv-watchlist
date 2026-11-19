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
console.log('admin-identity-revoke-page: ok');
