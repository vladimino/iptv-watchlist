// AIR-562: the pure Channel admin module shared by the page and the Worker (src/domain/epg-channel-admin.js): M3U parse without stream URLs, the submission
// validator, list filters and the preview diff. No storage, no network.
import assert from 'node:assert/strict';
import * as A from '../src/domain/epg-channel-admin.js';

// parse
const p = A.parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="tvg_5" tvg-name="A, B" group-title="G1",Display\nhttp://h/x?token=T\n#EXTINF:-1 tvg-id="tvg_6" group-title="G1",Six\n#EXTGRP:G2\nhttp://h/y\n#EXTINF:-1 tvg-id="tvg_7",Seven\nhttp://h/z\n');
assert.deepEqual(p.entries, [{sourceId: 'tvg_5', name: 'A, B', group: 'G1'}, {sourceId: 'tvg_6', name: 'Six', group: 'G2'}, {sourceId: 'tvg_7', name: 'Seven', group: null}], 'quoted comma kept; #EXTGRP wins; no group stays null');
assert.deepEqual(p.groups, ['G1', 'G2'], 'groups in first-seen order');
assert.ok(!JSON.stringify(p).includes('http'), 'no URL is returned');
const o = A.parseM3u('#EXTINF:-1 tvg-id="tvg_1",One\n#EXTINF:-1 tvg-id="tvg_2",Two\nhttp://h/2\n#EXTINF:-1 tvg-id="tvg_3",Three\n');
assert.equal(o.issues.orphan, 2, 'an entry without a stream line is counted and dropped');
assert.deepEqual(o.entries.map(e => e.sourceId), ['tvg_2']);
const u = A.parseM3u('#EXTINF:-1 tvg-id="tvg_1" group-title="ok",http://leak/x\nhttp://h/1\n');
assert.equal(u.issues.unsafe, 1); assert.equal(u.entries.length, 0);
assert.deepEqual(A.parseM3u(null).entries, []);
assert.equal(A.parseM3u('a\n'.repeat(10), {maxLines: 3}).truncated, true);
assert.ok(A.unsafeValue('rtsp://x') && A.unsafeValue('x&token=1') && A.unsafeValue('password=abc') && !A.unsafeValue('Sport 1 HD') && !A.unsafeValue('Token Film'));

// validate
const ok = A.validateSubmission({groups: [{name: 'G', policy: 'discover'}], entries: [{sourceId: 'tvg_1', name: null, group: null}]});
assert.equal(ok.ok, true);
for (const bad of [null, [], {}, {groups: [], entries: 'x'}, {groups: [{name: 'G', policy: 'x'}], entries: []}, {groups: [], entries: [{sourceId: 'tvg_1', name: 1, group: null}]}, {groups: [], entries: [{sourceId: 'tvg_1', name: null}]}, {groups: [], entries: [{sourceId: 'tvg_1', name: 'x'.repeat(201), group: null}]}])
  assert.equal(A.validateSubmission(bad).ok, false, JSON.stringify(bad));
assert.equal(A.validateSubmission({groups: [], entries: Array.from({length: 200}, () => ({sourceId: 'x\u0001', name: null, group: null}))}).errors.length, 50, 'errors are bounded');
assert.ok(A.validateNote(null) && A.validateNote('fine') && !A.validateNote('x'.repeat(501)) && !A.validateNote('http://x') && !A.validateNote(5));

// views and filters
const cats = new Map([['a', {categoryKey: 'a', name: 'A', policy: 'discover'}], ['b', {categoryKey: 'b', name: 'B', policy: 'deny_all'}]]);
const mk = (id, extra = {}) => ({channelId: id, sourceId: 'tvg_' + Number(id.slice(2)), origin: 'm3u', name: 'N' + id, categoryKey: null, ownerCategoryKey: null, overridePolicy: null, listed: true, ...extra});
assert.deepEqual(A.effectiveOf(mk('ch001'), cats), {policy: 'known_only', basis: 'unclassified'});
assert.deepEqual(A.effectiveOf(mk('ch001', {categoryKey: 'a'}), cats), {policy: 'discover', basis: 'category'});
assert.deepEqual(A.effectiveOf(mk('ch001', {categoryKey: 'a', ownerCategoryKey: 'b'}), cats), {policy: 'deny_all', basis: 'owner_category'});
assert.deepEqual(A.effectiveOf(mk('ch001', {categoryKey: 'a', ownerCategoryKey: 'b', overridePolicy: 'known_only'}), cats), {policy: 'known_only', basis: 'override'});
const views = [mk('ch001', {categoryKey: 'a'}), mk('ch002', {origin: 'xmltv', sourceId: null}), mk('ch003', {categoryKey: 'b', listed: false})].map(c => A.channelView(c, cats, new Map([['ch001', {shows: 2, lastStartMs: 5}]])));
assert.deepEqual(views[0].lastSeenInEpg, {shows: 2, lastStartMs: 5}); assert.equal(views[1].lastSeenInEpg, null);
const ids = f => A.filterChannels(views, f).map(v => v.channelId);
assert.deepEqual(ids({queue: 'unclassified'}), ['ch002']);
assert.deepEqual(ids({category: 'a'}), ['ch001']); assert.deepEqual(ids({category: 'none'}), ['ch002']);
assert.deepEqual(ids({policy: 'deny_all'}), ['ch003']); assert.deepEqual(ids({source: 'xmltv'}), ['ch002']); assert.deepEqual(ids({source: 'unlisted'}), ['ch003']);
assert.deepEqual(ids({q: ' NCH002 '}), ['ch002']); assert.deepEqual(ids({q: 'tvg_3'}), ['ch003']); assert.deepEqual(ids({}), ['ch001', 'ch002', 'ch003']);

// preview is bounded
const stored = new Map(Array.from({length: 450}, (_, n) => [`ch${String(n + 1).padStart(3, '0')}`, mk(`ch${String(n + 1).padStart(3, '0')}`, {categoryKey: 'a'})]));
const preview = A.buildPreview({categories: cats, channels: stored}, {categories: [{categoryKey: 'a', name: 'A', policy: 'discover'}], channels: []});
assert.equal(preview.totals.unlisted, 450); assert.equal(preview.items.unlisted.length, A.PREVIEW_ITEM_CAP); assert.equal(preview.capped, true);
assert.deepEqual(preview.categories.removed.map(c => c.name), ['B']);
console.log('Channel admin domain: M3U parse keeps no stream URL, validator, filters, bounded preview.');
