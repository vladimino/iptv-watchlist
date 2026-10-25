export function bundleAdmin(sources) {
  return sources.map(source => source.replace(/^\s*import\s.+$/gm, '').replace(/^export\s+/gm, '')).join('\n');
}
