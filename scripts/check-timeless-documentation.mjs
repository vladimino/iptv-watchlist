import { execFileSync } from 'node:child_process';

const maintained = /^docs\/(?:reference|architecture|runbooks)\/.*\.md$/;
const suspicious = /\bAIR-\d+\b|\b(?:since|before|after|introduced by|implemented in|delivered by)\s+(?:AIR-\d+|this PR)\b|\b(?:unchanged|not modified)\s+in\s+(?:this|the)\s+PR\b/i;

export function inspectAddedLines(patch, file) {
  if (!maintained.test(file)) return [];
  const warnings = [];
  let lineNumber = 0;
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) { lineNumber = Number(header[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      const content = line.slice(1);
      if (suspicious.test(content)) warnings.push({ file, line: lineNumber, text: content.trim().slice(0, 180) });
      lineNumber++;
    } else if (line.startsWith(' ')) lineNumber++;
  }
  return warnings;
}

function main() {
  let base = process.env.GITHUB_EVENT_BEFORE;
  const head = process.env.GITHUB_SHA || 'HEAD';
  if (!/^[a-f0-9]{40}$/.test(base || '') || /^0{40}$/.test(base)) base = 'HEAD^';
  const changed = execFileSync('git', ['diff', '--name-only', base, head, '--', 'docs/reference', 'docs/architecture', 'docs/runbooks'], {encoding:'utf8'}).trim();
  if (!changed) return console.log('Timeless documentation: no relevant changes.');
  let count = 0;
  for (const file of changed.split('\n')) {
    if (!maintained.test(file)) continue;
    const patch = execFileSync('git', ['diff', '--unified=0', base, head, '--', file], {encoding:'utf8'});
    for (const hit of inspectAddedLines(patch, file)) {
      count++;
      const safe = hit.text.replace(/\r|\n|::/g, ' ');
      console.log('::warning file='+hit.file+',line='+hit.line+'::Possible task history in maintained documentation: '+safe);
    }
  }
  console.log('Timeless documentation: '+count+' advisory warning(s); review context before rewriting.');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) main();
