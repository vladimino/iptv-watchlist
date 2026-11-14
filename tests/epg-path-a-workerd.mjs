import assert from 'node:assert/strict';
import { assessResult } from '../scripts/epg-path-a-workerd.mjs';

const good = { error: null, answer: { sealError: null }, workerdProcesses: 1, verified: { exact: true } };
assert.deepEqual(assessResult(good), []);
assert.ok(assessResult({ ...good, error: { message: 'x' } }).includes('request failed'));
assert.ok(assessResult({ ...good, answer: null }).includes('no answer'));
assert.ok(assessResult({ ...good, answer: { sealError: 'boom' } }).includes('stageSealedGeneration threw'));
assert.ok(assessResult({ ...good, workerdProcesses: 0 }).includes('no workerd process sampled'));
assert.ok(assessResult({ ...good, verified: { exact: false } }).includes('count invariants not verified'));
assert.ok(assessResult({ ...good, verified: { error: 'x' } }).includes('count invariants not verified'));
assert.ok(assessResult({ ...good, verified: null }).includes('count invariants not verified'));
console.log('epg-path-a-workerd: failed measurements exit nonzero');
