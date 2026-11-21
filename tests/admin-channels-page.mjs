// AIR-562: the /admin/channels page boundary. The served bundle carries the pure parser, the client and the page script; the page reaches the API only through
// the client, sends only normalized entries, never touches EPG / Discovery / TMDB / R2, and writes only after an explicit confirmation.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {bundleAdmin} from '../src/admin/bundle.js';
import {scoped} from '../scripts/bundle-scope.mjs';

const html = fs.readFileSync('public/admin-channels.html', 'utf8');
const page = fs.readFileSync('public/admin-channels.js', 'utf8');
const client = fs.readFileSync('src/admin/channels-client.js', 'utf8');
const build = fs.readFileSync('build.mjs', 'utf8');
const css = fs.readFileSync('public/admin.css', 'utf8');
const bundle = bundleAdmin([scoped('src/domain/epg-channel-admin.js', 'EpgChannelAdmin'), client, page]);

for (const id of ['channels-status-body', 'channels-message', 'channels-import', 'channels-file', 'channels-parsed', 'channels-preview', 'channels-list-section', 'channels-filters', 'channels-q', 'channels-category', 'channels-policy', 'channels-source', 'channels-queue', 'channels-items', 'channels-more']) assert.match(html, new RegExp(`id="${id}"`), id);
assert.match(html, /<a href="\/admin\/channels" aria-current="page" data-return-carry>Каналы<\/a>/);
assert.match(html, /<script src="\/admin-channels\.js"><\/script>/);
assert.doesNotMatch(html, /не применяется|вступят в силу/, 'the static banner claims neither state: the page renders the API activation state');
assert.match(html, /id="channels-eyebrow"[^>]*>[^<]*ЗАГРУЖАЕТСЯ/, 'until the read answers, the banner says the state is loading');
{
 const Admin = await import('../src/domain/epg-channel-admin.js');
 const off = Admin.activationView({state: 'not_active'}), on = Admin.activationView({state: 'active'});
 assert.equal(off.mode, 'off'); assert.match(off.eyebrow, /В EPG НЕ ПРИМЕНЯЕТСЯ/); assert.match(off.saved, /не применено/);
 assert.equal(on.mode, 'on'); assert.match(on.eyebrow, /ВКЛЮЧЕНА/); assert.doesNotMatch(on.eyebrow + on.status + on.saved, /не применя|не читает|не включён/, 'the enabled state never says the policy is off');
 assert.match(on.saved, /следующей естественной генерацией/); assert.match(on.status, /событии «Обновлён EPG»/, 'enabled-for-next-scan is told apart from the revision the last generation applied');
 for (const bad of [undefined, null, {}, {state: 'weird'}, 'active', 7]) {
  const view = Admin.activationView(bad);
  assert.equal(view.mode, 'unknown', String(JSON.stringify(bad)) + ' is unknown'); assert.match(view.eyebrow, /НЕИЗВЕСТНО/); assert.match(view.status, /не считайте/);
 }
 assert.doesNotMatch(page, /В EPG не применено|не применяется, ни один скан/, 'the page script hard-codes no staged wording: receipts use the API state');
 assert.match(page, /channelsSavedClause\(\)[\s\S]*channelsSavedClause\(\)/, 'both the save and the import receipt use the activation clause');
 assert.match(page, /channelsRenderActivation\(result\.body && result\.body\.activation\)/, 'a failed read renders the state it carried, or unknown');
}
assert.match(html, /не запускают EPG, Discovery и TMDB/);
assert.doesNotMatch(html, /fetch\(|\/api\//);
assert.match(build, /assets\['\/admin\/channels'\]/);
assert.match(build, /assets\['\/admin-channels\.js'\]/);
assert.match(build, /fs\.readFileSync\('src\/admin\/channels\.js','utf8'\)/, 'the Worker bundle carries the route');

// Static boundary of what the browser can do.
assert.doesNotMatch(page, /\bfetch\(/, 'the page reaches the API only through the client');
assert.doesNotMatch(bundle, /Authorization|Bearer|api\.themoviedb\.org|TMDB_|\/api\/sync|\/api\/enrichment|\/mcp|resolver-lease|localStorage|sessionStorage|XMLHttpRequest|sendBeacon|\.url\b/, 'no token, no other route, no storage, no stream URL field');
assert.equal((client.match(/method:'POST'/g) || []).length, 1, 'one POST call site');
assert.deepEqual([...client.matchAll(/postChannels\('([^']+)'/g)].map(m => m[1]).sort(), ['/category', '/import', '/override', '/preview']);
assert.match(client, /CHANNELS_API='\/api\/admin\/channels'/);
assert.match(client, /'X-IPTV-Admin-Action':CHANNELS_ACTION_HEADER/);
for (const call of ['commitChannelImport', 'saveChannelOverride', 'saveChannelCategory']) assert.match(client, new RegExp(call + '=.*confirm:true'), call + ' always sends the explicit confirmation');
assert.doesNotMatch(client, /previewChannelImport=.*confirm/, 'a preview needs no confirmation and writes nothing');
// The import payload is built from normalized fields only.
assert.match(client, /groups:submission\.groups,entries:submission\.entries/);
assert.doesNotMatch(client + page, /rawPlaylist|rawText/, 'the raw playlist is never put in a request');
// The commit button exists only after a preview and stays disabled until the checkbox is ticked.
assert.match(page, /id="channels-commit-btn" class="admin-refresh" disabled/);
assert.match(page, /event\.target\.id === 'channels-confirm'\) channelsEl\('#channels-commit-btn'\)\.disabled = !event\.target\.checked/);
// A partial or damaged playlist can never be imported: the page asks the pure module and renders no preview button when anything blocks.
assert.match(page, /EpgChannelAdmin\.importBlockers\(parsed\)/);
assert.match(page, /\(blocking \? '' : `<h3>Политика групп<\/h3>[\s\S]*id="channels-preview-btn"/, 'the preview button exists only when nothing blocks');
assert.doesNotMatch(page, /missingId|orphan\b.*warn|Предупреждения/, 'a dropped entry is no longer a mere warning');
// The category note and the policy note are independent decisions with independent inputs.
assert.match(page, /data-field="category-note"[^>]*value="\$\{channelsEscape\(row\.ownerCategoryNote \|\| ''\)\}"/);
assert.match(page, /data-field="policy-note"[^>]*value="\$\{channelsEscape\(row\.overrideNote \|\| ''\)\}"/);
assert.match(page, /action === 'save-policy' \? '\[data-field=policy-note\]' : '\[data-field=category-note\]'/);
assert.doesNotMatch(page, /overrideNote \|\| row\.ownerCategoryNote|data-field=note/, 'one shared note input is gone');
assert.match(page, /нет опубликованных показов фильмов \(это не значит, что канал не в эфире\)/, 'presence is labelled as published Film shows');
// Nothing starts on open but the one read.
assert.equal((page.match(/\bgetChannels\(/g) || []).length, 1);
assert.match(page, /channelsInit\(\);\s*$/);
assert.match(css, /\.channels-groups label\{grid-template-columns:minmax\(0,1fr\)\}/, 'a mobile layout exists');

// The served page is the one built from these files.
const built = spawnSync(process.execPath, ['build.mjs'], {encoding: 'utf8'});
assert.equal(built.status, 0, built.stderr);
const served = fs.readFileSync('dist/server/index.js', 'utf8');
assert.ok(served.includes('adminChannelsRoute') && served.includes('/api/admin/channels/'), 'the Worker serves the route');
assert.ok(served.includes('/admin-channels.js'), 'the Worker serves the page script');
console.log('Channel admin page: bundled, API only through the client, normalized entries only, explicit confirmation, no EPG/Discovery/TMDB/R2 route.');
