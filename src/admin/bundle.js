export function bundleAdmin(sources) {
  return sources.map(source => source.replace(/^\s*import\s.+$/gm, '').replace(/^export\s+/gm, '')).join('\n');
}

// The pure query library as one namespace constant for the concatenated Worker script, so none of its helpers
// becomes a global of that script.
export const ADMIN_QUERY_EXPORTS = ['searchFilms', 'searchPeople', 'filmQueue', 'personQueue', 'filmQueueRecords', 'personQueueRecords', 'filmQueueCounts', 'personQueueCounts', 'getFilm', 'getPerson'];
export function bundleAdminQuery(source) {
  return 'const AdminQuery=(()=>{\n' + bundleAdmin([source]) + '\nreturn {' + ADMIN_QUERY_EXPORTS.join(',') + '};\n})();';
}
