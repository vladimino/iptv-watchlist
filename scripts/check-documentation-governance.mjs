import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const flagNames = ['SCORED_RESOLUTION', 'CANDIDATE_DISCOVERY', 'LIFECYCLE_LOCALIZATION', 'RATINGS_REFRESH', 'PREDICTION_VERSION_OBJECTS', 'CATALOG_POSTER_HYDRATION', 'PREDICTION_PROFILE_COMPATIBILITY'];

// The value must sit on the label's own line: a label left empty by the PR template must not pick
// up the next line as its value, so the whitespace after the colon excludes line breaks.
function entry(body, label) {
  const m = String(body || '').match(new RegExp('^[ \\t]*' + label + '[ \\t]*:[ \\t]*(.+)$', 'im'));
  return m?.[1]?.trim() || '';
}

export function checkDocumentation({ files, patches = {}, body }) {
  const errors = [];
  const changed = new Set(files);
  const impact = entry(body, 'Documentation impact');
  const architecture = entry(body, 'Architecture impact');
  const evidence = entry(body, 'Research evidence');
  if (!impact) errors.push('PR body must contain "Documentation impact: <paths or none with reason>".');
  if (/^none\b/i.test(impact) && !/^none\s*[-–:]\s*\S.{8,}/i.test(impact)) {
    errors.push('Documentation impact: none requires a concrete reason (e.g. "none - internal test-only fixture").');
  }
  if (!architecture || !/^(changed|none)\b/i.test(architecture)) {
    errors.push('PR body must declare "Architecture impact: changed" or "Architecture impact: none - <reason>".');
  }
  if (/^none\b/i.test(architecture) && !/^none\s*[-–:]\s*\S.{8,}/i.test(architecture)) {
    errors.push('Architecture impact: none requires a reason for review.');
  }
  if (!/^(yes|no)\b/i.test(evidence)) {
    errors.push('PR body must declare "Research evidence: yes" or "Research evidence: no".');
  }
  const flagTouched = Object.entries(patches).some(([path, patch]) =>
    (/^src\/.*\.[cm]?js$/.test(path) || path === 'wrangler.jsonc') &&
    patch.split('\n').some(line => /^[+-](?![+-])/.test(line) && flagNames.some(flag =>
      new RegExp('\\b' + flag + '\\b').test(line))));
  if (flagTouched && !changed.has('docs/reference/feature-flags.md')) {
    errors.push('Feature-flag references changed in src/ or wrangler.jsonc: update docs/reference/feature-flags.md or explain a false positive in review after fixing the check.');
  }
  if (/^yes\b/i.test(evidence) && !files.some(path => path.startsWith('docs/evidence/'))) {
    errors.push('Research evidence: yes requires a changed docs/evidence/ file.');
  }
  if (/^changed\b/i.test(architecture)) {
    if (!files.some(path => /^docs\/adr\/\d+.*\.md$/.test(path) && !path.endsWith('/README.md'))) errors.push('Architecture impact: changed requires a new docs/adr/*.md.');
    if (!files.some(path => path.startsWith('docs/architecture/') && path.endsWith('.md') && !path.endsWith('/README.md'))) errors.push('Architecture impact: changed requires affected docs/architecture/*.md diagrams.');
    if (!files.some(path => path.startsWith('docs/reference/') && path.endsWith('.md'))) errors.push('Architecture impact: changed requires affected docs/reference/*.md contracts.');
  }
  return errors;
}

function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    console.log('Documentation guardrails run for PRs only; no PR classification on this event.');
    return;
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base?.sha;
  const head = event.pull_request?.head?.sha;
  if (!/^[a-f0-9]{40}$/.test(base || '') || !/^[a-f0-9]{40}$/.test(head || '')) throw new Error('Missing validated PR base/head SHAs');
  const names = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' }).trim();
  const files = names ? names.split('\n') : [];
  const patches = {};
  for (const file of files.filter(f => /^src\/.*\.[cm]?js$/.test(f) || f === 'wrangler.jsonc')) {
    patches[file] = execFileSync('git', ['diff', '--unified=0', base, head, '--', file], { encoding: 'utf8' });
  }
  const problems = checkDocumentation({files, patches, body:event.pull_request?.body});
  for (const message of problems) console.error('Documentation governance: ' + message);
  if (problems.length) process.exitCode = 1;
  else console.log('Documentation governance declarations and structural guards passed. Manual architectural review is still mandatory.');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) main();
