import { execFileSync } from 'node:child_process';

const maintained = /^docs\/(?:reference|architecture|runbooks)\/.*\.md$/;
const navigation = /^(?:docs\/README\.md|docs\/(?:reference|architecture|runbooks)\/(?:.*\/)?README\.md)$/;
const suspicious = /\bAIR-\d+\b|\b(?:since|before|after|introduced by|implemented in|delivered by)\s+(?:AIR-\d+|this PR)\b|\b(?:unchanged|not modified)\s+in\s+(?:this|the)\s+PR\b/i;
const delivery = /\b(?:merged|delivered|implemented|introduced|shipped|completed)\s*(?:\(\s*|(?:in|by|across|via|under)\s+)(?:AIR-\d+)(?:\s*(?:[–-]|to)\s*(?:AIR-)?\d+)?\s*\)?\b|\bmerged\s*\(\s*AIR-\d+\s*\)/i;

export function inspectAddedLines(patch, file) {
  if (!maintained.test(file) && file !== 'docs/README.md') return [];
  const hits = [];
  let lineNumber = 0;
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) { lineNumber = Number(header[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      const content = line.slice(1);
      const severity = navigation.test(file) && delivery.test(content) ? 'error' : (maintained.test(file) && suspicious.test(content) ? 'warning' : null);
      if (severity) hits.push({ file, line: lineNumber, text: content.trim().slice(0, 180), severity });
      lineNumber++;
    } else if (line.startsWith(' ')) lineNumber++;
  }
  return hits;
}

export function inspectDiffs(patches) {
  return patches.flatMap(({ file, patch }) => inspectAddedLines(patch, file));
}

function main() {
  let base = process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.PR_BASE_SHA : process.env.GITHUB_EVENT_BEFORE;
  const head = process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.PR_HEAD_SHA : (process.env.GITHUB_SHA || 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(base || '') || /^0{40}$/.test(base)) base = 'HEAD^';
  const changed = execFileSync('git', ['diff', '--name-only', base, head, '--', 'docs/reference', 'docs/architecture', 'docs/runbooks', 'docs/README.md'], { encoding: 'utf8' }).trim();
  if (!changed) return console.log('Timeless documentation: no relevant changes.');
  let errors = 0, warnings = 0;
  for (const file of changed.split('\n')) {
    const patch = execFileSync('git', ['diff', '--unified=0', base, head, '--', file], { encoding: 'utf8' });
    for (const hit of inspectAddedLines(patch, file)) {
      if (hit.severity === 'error') errors++; else warnings++;
      const safe = hit.text.replace(/\r|\n|::/g, ' ');
      console.log('::' + hit.severity + ' file=' + hit.file + ',line=' + hit.line + '::' + (hit.severity === 'error' ? 'Task delivery is not a maintained navigation status; describe the current document instead: ' : 'Review possible task history in maintained documentation: ') + safe);
    }
  }
  console.log('Timeless documentation: ' + errors + ' error(s), ' + warnings + ' advisory warning(s).');
  if (errors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) main();
