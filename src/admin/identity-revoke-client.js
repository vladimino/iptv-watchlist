// ADR 0178 / AIR-132: the browser client of the owner revoke workflow. One GET (read-only preview) and two POSTs
// (confirmation, execution) of the discovery-recovery routes. No other request, no TMDB, no retry: an unknown outcome is
// shown, never repeated. The action header is the one the existing identity writes carry.
const REVOKE_API = '/api/admin/discovery-recovery/';

function revokeIdempotencyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return 'revoke-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function revokeRead(response) {
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  if (!response.ok) {
    const error = parsed && typeof parsed.refusal === 'string' ? parsed.refusal : parsed && typeof parsed.error === 'string' ? parsed.error : 'http_' + response.status;
    return {ok: false, status: response.status, error, body: parsed};
  }
  return {ok: true, status: response.status, error: null, body: parsed};
}

async function revokePreviewGet(key, requestId, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const query = 'key=' + encodeURIComponent(key) + '&requestId=' + encodeURIComponent(requestId);
  try { return await revokeRead(await fetchImpl(REVOKE_API + 'revoke-preview?' + query, {headers: {Accept: 'application/json'}, credentials: 'same-origin'})); }
  catch { return {ok: false, status: 0, error: 'network', body: null}; }
}

async function revokePost(path, body, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  try {
    return await revokeRead(await fetchImpl(REVOKE_API + path, {
      method: 'POST', credentials: 'same-origin', body: JSON.stringify(body),
      headers: {Accept: 'application/json', 'Content-Type': 'application/json', 'X-IPTV-Admin-Action': 'discovery_identity_correct'},
    }));
  } catch { return {ok: false, status: 0, error: 'network', body: null}; }
}

function revokeConfirmPost(body, options = {}) {
  return revokePost('revoke-confirm', {...body, idempotencyKey: options.idempotencyKey || revokeIdempotencyKey(), accepted: true}, options);
}

function revokeExecutePost(confirmation, options = {}) {
  return revokePost('revoke-execute', {confirmation}, options);
}
