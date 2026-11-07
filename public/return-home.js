// AIR-380. One validated "return to the programme" contract shared by the programme page (film screen, events screen) and the admin pages.
//
// The home target (the programme's path, query and hash) travels in the URL of every page opened from it, as the single parameter `return`,
// encoded once with encodeURIComponent. It survives nested navigation and a reload because it is in the URL, not in script state or storage.
// Only a canonical internal home target is accepted: pathname exactly `/`, no scheme, no host, no `//`, no backslash, no control character.
// Anything else (missing, malformed, external, `javascript:`) falls back to `/`, so there is no open redirect and no stale session state.
//
// Loaded as a classic script before app.js / the admin scripts and by tests; the top-level binding is shared by scripts of the same page.
const ReturnHome = (() => {
  const PARAM = 'return';
  const HOME = '/';
  const LABEL = 'На главную';
  const MAX_LENGTH = 2048;
  const PROBE = 'https://home.invalid';

  // A valid home target in its normalized form (what the browser would send), or null.
  function parseTarget(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_LENGTH) return null;
    if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
    if (value[0] !== '/' || value[1] === '/') return null;
    let url;
    try {url = new URL(value, PROBE);} catch {return null;}
    if (url.origin !== PROBE || url.pathname !== HOME) return null;
    return url.pathname + url.search + url.hash;
  }

  // The target named by a query string (`location.search`), or the canonical home. The first `return` that is valid wins.
  function fromSearch(search) {
    let params;
    try {params = new URLSearchParams(String(search || ''));} catch {return HOME;}
    for (const value of params.getAll(PARAM)) {
      const target = parseTarget(value);
      if (target) return target;
    }
    return HOME;
  }

  // The home target of the programme page itself: its own path, query and hash.
  function ofHomeLocation(location) {
    return parseTarget(String(location.pathname || '') + String(location.search || '') + String(location.hash || '')) || HOME;
  }

  function split(href) {
    const text = String(href);
    const hashAt = text.indexOf('#');
    const noHash = hashAt >= 0 ? text.slice(0, hashAt) : text;
    const hash = hashAt >= 0 ? text.slice(hashAt) : '';
    const queryAt = noHash.indexOf('?');
    return {path: queryAt >= 0 ? noHash.slice(0, queryAt) : noHash, query: queryAt >= 0 ? noHash.slice(queryAt + 1) : '', hash};
  }
  function keyOf(pair) {
    const name = pair.split('=')[0];
    try {return decodeURIComponent(name.replace(/\+/g, ' '));} catch {return name;}
  }

  // The same href without any `return` parameter; the other parameters are kept byte for byte.
  function stripReturn(href) {
    const {path, query, hash} = split(href);
    const kept = query ? query.split('&').filter(pair => pair !== '' && keyOf(pair) !== PARAM) : [];
    return path + (kept.length ? '?' + kept.join('&') : '') + hash;
  }

  // The href carrying `target`. The canonical home needs no parameter; an invalid target is treated as the canonical home.
  function withReturn(href, target) {
    const base = stripReturn(href);
    const clean = parseTarget(target);
    if (!clean || clean === HOME) return base;
    const {path, query, hash} = split(base);
    return path + '?' + (query ? query + '&' : '') + PARAM + '=' + encodeURIComponent(clean) + hash;
  }

  // For page scripts that rewrite their own URL: keep the return context of the current page in the new href.
  function keep(href, search) {
    return withReturn(href, fromSearch(search));
  }

  const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // The one link markup: label, class and the `data-return-home` hook are the same on every page.
  function linkHtml(target) {
    return '<a class="return-home" data-return-home href="' + escapeAttribute(parseTarget(target) || HOME) + '">' + LABEL + '</a>';
  }

  // Points every `[data-return-home]` link at the target and every `[data-return-carry]` link at its own base href plus the target.
  // Idempotent: the base of a carrying link is remembered the first time, so repeated calls never stack parameters.
  function decorate(root, target) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const clean = parseTarget(target) || HOME;
    for (const link of root.querySelectorAll('[data-return-home]')) link.setAttribute('href', clean);
    for (const link of root.querySelectorAll('[data-return-carry]')) {
      if (link.dataset.returnBase === undefined) link.dataset.returnBase = stripReturn(link.getAttribute('href') || '');
      link.setAttribute('href', withReturn(link.dataset.returnBase, clean));
    }
  }

  // Admin pages: the target is whatever the URL says.
  function init(doc, location) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    const locationRef = location || (typeof window !== 'undefined' ? window.location : null);
    if (!documentRef || !locationRef) return HOME;
    const target = fromSearch(locationRef.search);
    decorate(documentRef, target);
    return target;
  }

  return {PARAM, HOME, LABEL, parseTarget, fromSearch, ofHomeLocation, stripReturn, withReturn, keep, linkHtml, decorate, init};
})();

// In a browser the script runs once while the page is built; tests load the file without a current script and call the functions directly.
if (typeof document !== 'undefined' && document.currentScript) {
  try {ReturnHome.init();} catch {}
}
