// ADR 0181 / AIR-131: the browser client of the owner group workflow. One GET preview, two POSTs (confirmation, execution) and one GET
// receipt of the group-* routes. No other request, no TMDB, no retry: an unknown outcome is shown, never repeated. The action header is
// the one the existing identity writes carry.
const GROUP_API = '/api/admin/discovery-recovery/';

function groupIdempotencyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return 'group-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function groupRead(response) {
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  if (!response.ok) {
    const error = parsed && typeof parsed.refusal === 'string' ? parsed.refusal : parsed && typeof parsed.error === 'string' ? parsed.error : 'http_' + response.status;
    return {ok: false, status: response.status, error, body: parsed};
  }
  return {ok: true, status: response.status, error: null, body: parsed};
}

async function groupGet(path, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  try { return await groupRead(await fetchImpl(GROUP_API + path, {headers: {Accept: 'application/json'}, credentials: 'same-origin'})); }
  catch { return {ok: false, status: 0, error: 'network', body: null}; }
}

function groupPreviewGet(tmdbId, options = {}) {
  return groupGet('group-preview?tmdbId=' + encodeURIComponent(tmdbId), options);
}

function groupReceiptGet(groupKey, options = {}) {
  return groupGet('group-receipt?groupKey=' + encodeURIComponent(groupKey), options);
}

async function groupPost(path, body, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  try {
    return await groupRead(await fetchImpl(GROUP_API + path, {
      method: 'POST', credentials: 'same-origin', body: JSON.stringify(body),
      headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'X-IPTV-Admin-Action': 'discovery_identity_correct'},
    }));
  } catch { return {ok: false, status: 0, error: 'network', body: null}; }
}

function groupConfirmPost(body, options = {}) {
  return groupPost('group-confirm', {...body, idempotencyKey: options.idempotencyKey || groupIdempotencyKey(), accepted: true}, options);
}

function groupExecutePost(confirmation, options = {}) {
  return groupPost('group-execute', {confirmation}, options);
}
