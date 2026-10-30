// The machine-to-human presentation layer of guarded actions: every code the action contract and the data health model
// can emit has declared Russian copy; any undeclared code, a missing trusted title or issue, or a descriptor that
// disagrees with the capability makes the presentation unexplainable, which never offers a confirmation and never shows
// the raw code outside the technical details. The layer is pure and leaves the domain contract text-free.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ADMIN_ACTION_COMPENSATION, ADMIN_ACTION_ERROR_CODES, ADMIN_ACTION_PREVIEW_STATES, ADMIN_ACTION_RECORD_OUTCOMES, ADMIN_ACTION_REFUSALS, ADMIN_ACTION_RUN_STATES,
  defineCapability, createRegistry, previewAction,
} from '../src/domain/admin-actions.js';
import {DATA_HEALTH_ELIGIBILITY_REASONS, DATA_HEALTH_REASONS} from '../src/domain/data-health.js';
import {FIXTURE_CAPABILITY, FIXTURE_DESCRIPTOR, fixtureRegistry} from '../src/admin/actions-fixture.js';
import {
  ACTION_COMPENSATION_COPY, ACTION_ERROR_COPY, ACTION_EXCLUSION_COPY, ACTION_ISSUE_REASON_COPY, ACTION_NON_ATOMIC, ACTION_OUTCOME_COPY, ACTION_PREVIEW_REASON_COPY,
  ACTION_PREVIEW_STATE_COPY, ACTION_RECEIPT_UNEXPLAINABLE, ACTION_REFUSAL_COPY, ACTION_RUN_STATE_COPY, ACTION_UNEXPLAINABLE,
  actionCount, actionCountOf, createDescriptorRegistry, presentPreview, presentReceipt, validDescriptor,
} from '../src/admin/actions-presentation.js';

const source = fs.readFileSync('src/admin/actions-presentation.js', 'utf8');
assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|\bimport\b|\brequire\(|document\.|localStorage|Date\.now|new Date\(|Math\.random|anthropic|openai|llm/i, 'the presentation layer is pure: no I/O, clock, randomness or model');
const contract = fs.readFileSync('src/domain/admin-actions.js', 'utf8');
assert.doesNotMatch(contract, /[Ѐ-ӿ]|actions-presentation|ACTION_[A-Z_]*COPY/, 'the domain contract stays text-independent');

const sorted = values => [...values].sort();
const CYRILLIC = /[Ѐ-ӿ]/;
function assertCopy(table, codes, name) {
  assert.deepEqual(sorted(Object.keys(table)), sorted(codes), name + ' covers exactly the known codes');
  for (const [code, value] of Object.entries(table)) {
    for (const text of typeof value === 'string' ? [value] : Object.entries(value).filter(([key, item]) => key !== 'tone' && typeof item === 'string' && item).map(([, item]) => item)) {
      assert.match(text, CYRILLIC, `${name}.${code} is Russian`);
      assert.doesNotMatch(text, /[a-z]+_[a-z]+/, `${name}.${code} carries no raw code`);
    }
  }
}

// 1. Exhaustive code-to-copy mappings over every exported code list.
assertCopy(ACTION_PREVIEW_STATE_COPY, ADMIN_ACTION_PREVIEW_STATES, 'preview states');
assertCopy(ACTION_RUN_STATE_COPY, ADMIN_ACTION_RUN_STATES, 'run states');
assertCopy(ACTION_OUTCOME_COPY, ADMIN_ACTION_RECORD_OUTCOMES, 'record outcomes');
assertCopy(ACTION_REFUSAL_COPY, ADMIN_ACTION_REFUSALS, 'refusals');
assertCopy(ACTION_ERROR_COPY, ADMIN_ACTION_ERROR_CODES, 'error codes');
assertCopy(ACTION_COMPENSATION_COPY, ADMIN_ACTION_COMPENSATION, 'compensation');
assertCopy(ACTION_ISSUE_REASON_COPY, DATA_HEALTH_REASONS, 'issue reasons');
const PREVIEW_EXCLUSIONS = ['no_issue', 'not_eligible', 'record_not_read', 'subject_kind_differs', 'version_unknown'];
assertCopy(ACTION_EXCLUSION_COPY, [...DATA_HEALTH_ELIGIBILITY_REASONS, ...PREVIEW_EXCLUSIONS], 'exclusion reasons');
const PREVIEW_REASONS = ['eligible', 'not_eligible', 'budget_exceeded', 'evidence_incomplete', 'no_records', 'stale_pin', 'observation_incomplete', 'invalid_request', 'unsupported_capability', 'unsupported_subject'];
assertCopy(ACTION_PREVIEW_REASON_COPY, PREVIEW_REASONS, 'preview reasons');
for (const [code, value] of Object.entries(ACTION_PREVIEW_REASON_COPY)) assert.ok(value.next, 'preview reason ' + code + ' has a next step');
for (const [code, value] of Object.entries(ACTION_EXCLUSION_COPY)) assert.ok(value.why && value.next, 'exclusion ' + code + ' has a reason and a next step');
for (const [code, value] of Object.entries(ACTION_REFUSAL_COPY)) assert.ok(value.why && value.fix, 'refusal ' + code + ' has a reason and a fix');

// Every status, reason and exclusion the contract really emits is among the declared codes.
const registry = fixtureRegistry(), descriptors = createDescriptorRegistry([FIXTURE_DESCRIPTOR]);
const issue = (id, eligible, reason = 'metadata_stale', actionReason) => ({id: 'metadata/' + id, reason, subject: {kind: 'film', id}, evidence: {completeness: eligible === null ? 'partial' : 'complete'}, action: {suggested: 'bounded_action', code: 'metadata_refresh', eligible, reason: actionReason ?? (eligible === true ? 'eligible' : eligible === false ? 'generation_changed' : 'evidence_incomplete')}});
const request = (extra = {}) => ({capability: FIXTURE_CAPABILITY.id, version: 1, subject: {kind: 'film', id: 'metadata'}, pin: 'p1', ...extra});
const observe = (records, issues, extra = {}) => ({pin: 'p1', now: '2026-10-30T20:00:00.000Z', records, issues, ...extra});
const many = Array.from({length: 6}, (_, index) => 'film:' + index);
const emitted = [
  previewAction(registry, {}, observe([], [])),
  previewAction(registry, request({capability: 'missing_action'}), observe([], [])),
  previewAction(registry, request({subject: {kind: 'observation', id: 'x'}}), observe([], [])),
  previewAction(registry, request(), {pin: 'p1'}),
  previewAction(registry, request(), observe([], [], {pin: 'p2'})),
  previewAction(registry, request(), observe([], [])),
  previewAction(registry, request(), observe([{id: 'film:a', version: 'v1'}, {id: 'film:b', version: 'v1'}], [issue('film:a', true)])),
  previewAction(registry, request(), observe([{id: 'film:a', version: 'v1'}], [issue('film:a', false)])),
  previewAction(registry, request(), observe([{id: 'film:a', version: 'v1'}], [issue('film:a', null)])),
  previewAction(registry, request(), observe(many.map(id => ({id, version: 'v1'})), many.map(id => issue(id, true)))),
  previewAction(registry, request({ids: ['film:a', 'film:gone']}), observe([{id: 'film:a', version: 'v1', kind: 'observation'}, {id: 'film:b'}], [issue('film:b', true)])),
  previewAction(registry, request(), observe([{id: 'film:b'}], [issue('film:b', true)])),
];
for (const preview of emitted) {
  assert.ok(ACTION_PREVIEW_STATE_COPY[preview.status], 'declared state ' + preview.status);
  assert.ok(ACTION_PREVIEW_REASON_COPY[preview.reason], 'declared reason ' + preview.reason);
  for (const item of preview.excluded) assert.ok(ACTION_EXCLUSION_COPY[item.reason], 'declared exclusion ' + item.reason);
}
assert.deepEqual(sorted(new Set(emitted.map(preview => preview.reason))), sorted(PREVIEW_REASONS), 'the exercised previews reach every preview reason');

// 2. A complete explanation for an eligible preview, built only from the descriptor, typed issues and trusted titles.
const titles = {'film:a': 'Альфа', 'film:b': 'Бета', 'film:c': 'Гамма'};
const issues = [issue('film:a', true, 'metadata_missing'), issue('film:b', true, 'metadata_partial'), issue('film:c', false)];
const observation = observe([{id: 'film:a', version: 'v1'}, {id: 'film:b', version: 'v1'}, {id: 'film:c', version: 'v1'}], issues);
const eligible = previewAction(registry, request(), observation);
const frozen = structuredClone(eligible);
const model = presentPreview(eligible, descriptors, {titles, issues});
assert.deepEqual(eligible, frozen, 'presenting never mutates the preview');
assert.equal(model.explainable, true);
assert.equal(model.title, 'Проверка перед обновлением метаданных');
assert.equal(model.status.headline, 'Можно смоделировать изменение');
assert.equal(model.status.detail, 'Изменение затронет 2 тестовых фильма, ещё 1 тестовый фильм пропустим.');
assert.deepEqual(model.included.map(item => [item.name, item.text]), [
  ['Тестовый фильм «Альфа»', 'Причина: метаданных нет совсем. Сведения собраны полностью.'],
  ['Тестовый фильм «Бета»', 'Причина: метаданные заполнены не полностью. Сведения собраны полностью.'],
]);
assert.deepEqual(model.excluded, [{name: 'Тестовый фильм «Гамма»', text: 'Не будем изменять тестовый фильм «Гамма»: сведения относятся к предыдущему обновлению, поэтому сейчас нельзя безопасно продолжать.', next: 'Сначала обновите сведения и повторите проверку.'}]);
assert.equal(model.risks[0], ACTION_NON_ATOMIC);
assert.ok(model.risks.includes(ACTION_COMPENSATION_COPY.restore_before_image));
assert.ok(model.risks.includes('Внешние сервисы это действие не вызывает.'));
assert.ok(model.risks.some(risk => /Подтверждение действует 10 мин/.test(risk)));
assert.equal(model.confirm.cta, 'Смоделировать изменение (2 тестовых фильма)');
assert.match(model.confirm.label, /для 2 тестовых фильма — тестовый фильм «Альфа», тестовый фильм «Бета»\./);
const primaryText = value => JSON.stringify({...value, technical: undefined});
assert.doesNotMatch(primaryText(model), /film:|\bv1\b|metadata_|generation_changed|ineligible|atomic|p1\b|[0-9a-f]{8}/, 'nothing internal outside the technical rows');
assert.ok(model.technical.some(([, value]) => value.includes('film:a · v1')), 'technical rows keep ids and versions');
assert.ok(model.technical.some(([label, value]) => label === 'Отпечаток объёма' && value === eligible.scopeFingerprint));

// 3. Fail closed: an undeclared code or unverifiable fact never yields an explanation or a confirmation.
function assertUnexplainable(preview, context, raw, why) {
  const result = presentPreview(preview, descriptors, context);
  assert.equal(result.explainable, false, why);
  assert.equal(result.message, ACTION_UNEXPLAINABLE, why);
  assert.equal(result.confirm, null, why + ': never confirmable');
  if (raw) assert.ok(!primaryText(result).includes(raw), why + ': the raw code stays out of the primary text');
}
const context = {titles, issues};
assertUnexplainable({...eligible, status: 'future_status'}, context, 'future_status', 'unknown preview state');
assertUnexplainable({...eligible, reason: 'future_reason'}, context, 'future_reason', 'unknown preview reason');
assertUnexplainable({...eligible, excluded: [{id: 'film:c', status: 'ineligible', reason: 'future_exclusion'}]}, context, 'future_exclusion', 'unknown exclusion reason');
assertUnexplainable(eligible, {titles, issues: issues.map(entry => ({...entry, reason: 'future_issue'}))}, 'future_issue', 'unknown issue reason');
assertUnexplainable(eligible, {titles, issues: issues.map(entry => ({...entry, action: {...entry.action, code: 'poster_hydration'}}))}, null, 'an issue for another action code');
assertUnexplainable(eligible, {titles, issues: issues.map(entry => ({...entry, subject: {...entry.subject, kind: 'observation'}}))}, null, 'an issue for another subject kind');
assertUnexplainable(eligible, {titles, issues: issues.map(entry => ({...entry, evidence: {completeness: 'partial'}}))}, null, 'incomplete evidence on an included record');
assertUnexplainable(eligible, {titles, issues: []}, null, 'no typed issue for an included record');
assertUnexplainable(eligible, {titles: {'film:b': 'Бета'}, issues}, null, 'an included record without a trusted title');
assertUnexplainable(eligible, {titles: {'film:a': '   ', 'film:b': 'Бета'}, issues}, null, 'a blank title is not a title');
assertUnexplainable({...eligible, capability: 'unknown_action'}, context, 'unknown_action', 'no descriptor for the capability');
assertUnexplainable({...eligible, version: 2}, context, null, 'no descriptor for the capability version');
assertUnexplainable({...eligible, compensation: {kind: 'none', guidance: ''}}, context, null, 'a descriptor that disagrees on compensation');
assertUnexplainable({...eligible, budget: {...eligible.budget, externalCalls: 2}}, context, null, 'undeclared external calls');
assertUnexplainable({...eligible, subject: {kind: 'observation', id: 'x'}}, context, null, 'another subject kind');
for (const value of [null, undefined, 'eligible', 42, []]) assert.equal(presentPreview(value, descriptors, context).explainable, false);
assert.equal(presentPreview(eligible, null, context).explainable, false, 'no descriptor registry');
// An excluded record without a title is still described without inventing a name or showing its id.
const untitled = presentPreview(eligible, descriptors, {titles: {'film:a': 'Альфа', 'film:b': 'Бета'}, issues});
assert.equal(untitled.excluded[0].name, 'Запись без проверенного названия');

// 4. Receipts: N of M, per-record next steps, refusals with a fix, and fail closed on undeclared codes.
const confirmationFields = {schemaVersion: 1, capability: FIXTURE_CAPABILITY.id, version: 1};
const receipt = (state, outcomes, extra = {}) => ({...confirmationFields, state, refusal: null, atomic: false, outcomes, retry: {retryable: [], maxAttempts: 2}, ...extra});
const partial = presentReceipt(receipt('partial', [{id: 'film:a', outcome: 'written'}, {id: 'film:b', outcome: 'failed', error: 'rate_limited'}], {retry: {retryable: ['film:b'], maxAttempts: 2}}), descriptors, context);
assert.equal(partial.headline, 'Получилось частично');
assert.equal(partial.summary, 'Удалось для 1 из 2 тестовых фильмов. Это моделирование: реальные фильмы не менялись.');
assert.deepEqual(partial.lines.map(line => [line.name, line.text, line.next]), [
  ['Тестовый фильм «Альфа»', 'Изменено.', ''],
  ['Тестовый фильм «Бета»', 'Не удалось — источник временно ограничил число запросов.', 'Можно повторить: запустите проверку заново и подтвердите новый список.'],
]);
const unknown = presentReceipt(receipt('unknown', [{id: 'film:a', outcome: 'unknown', error: 'timeout'}, {id: 'film:b', outcome: 'skipped_changed', error: 'conflict'}]), descriptors, context);
assert.match(unknown.next, /НЕ повторяйте/);
assert.equal(unknown.lines[0].next, 'НЕ повторяйте, пока не проверите карточку этого фильма.');
assert.match(unknown.lines[1].text, /не перезаписали/);
for (const refusal of ADMIN_ACTION_REFUSALS) {
  const refused = presentReceipt({state: 'refused', refusal, outcomes: []}, descriptors, context);
  assert.equal(refused.explainable, true);
  assert.equal(refused.headline, 'Отказано: ничего не выполнялось');
  assert.ok(refused.summary.startsWith('Причина: ') && refused.next.startsWith('Как исправить: '));
  assert.ok(!primaryText(refused).includes(refusal), 'refusal ' + refusal + ' is not shown raw');
}
for (const [value, raw] of [
  [{state: 'future_state', outcomes: []}, 'future_state'],
  [{state: 'refused', refusal: 'future_refusal', outcomes: []}, 'future_refusal'],
  [receipt('partial', [{id: 'film:a', outcome: 'future_outcome'}]), 'future_outcome'],
  [receipt('failed', [{id: 'film:a', outcome: 'failed', error: 'future_error'}]), 'future_error'],
  [receipt('succeeded', [{id: 'film:a', outcome: 'written'}], {capability: 'unknown_action'}), null],
  [null, null],
]) {
  const result = presentReceipt(value, descriptors, context);
  assert.equal(result.explainable, false);
  assert.equal(result.message, ACTION_RECEIPT_UNEXPLAINABLE);
  if (raw) assert.ok(!primaryText(result).includes(raw));
}

// 5. Descriptors: complete, consistent declarations only.
assert.equal(validDescriptor(FIXTURE_DESCRIPTOR), true);
assert.equal(FIXTURE_DESCRIPTOR.capability, FIXTURE_CAPABILITY.id);
assert.equal(FIXTURE_DESCRIPTOR.healthActionCode, FIXTURE_CAPABILITY.healthActionCode);
assert.equal(FIXTURE_DESCRIPTOR.compensation, FIXTURE_CAPABILITY.compensation.kind);
assert.ok(FIXTURE_CAPABILITY.subjectKinds.includes(FIXTURE_DESCRIPTOR.subjectKind));
for (const broken of [
  null, {}, {...FIXTURE_DESCRIPTOR, version: 0}, {...FIXTURE_DESCRIPTOR, title: ''}, {...FIXTURE_DESCRIPTOR, problem: '  '},
  {...FIXTURE_DESCRIPTOR, subjectLabel: 'фильм'}, {...FIXTURE_DESCRIPTOR, confirm: 'Подтверждаю'}, {...FIXTURE_DESCRIPTOR, noun: {one: 'фильм'}},
  {...FIXTURE_DESCRIPTOR, fields: []}, {...FIXTURE_DESCRIPTOR, risks: [1]}, {...FIXTURE_DESCRIPTOR, compensation: 'rollback'},
  {...FIXTURE_DESCRIPTOR, simulation: 'yes'}, {...FIXTURE_DESCRIPTOR, simulationNote: ''}, {...FIXTURE_DESCRIPTOR, externalCalls: ''},
]) assert.equal(validDescriptor(broken), false);
assert.throws(() => createDescriptorRegistry([{...FIXTURE_DESCRIPTOR, cta: ''}]), /invalid action descriptor/);
assert.throws(() => createDescriptorRegistry([FIXTURE_DESCRIPTOR, FIXTURE_DESCRIPTOR]), /duplicate/);
// A live capability with declared external calls is explainable; its call count stays a technical detail.
const live = defineCapability({id: 'live_example', version: 1, subjectKinds: ['film'], healthActionCode: 'metadata_refresh', budget: {externalCallsPerRecord: 1}, compensation: {kind: 'manual'}});
const liveDescriptors = createDescriptorRegistry([{...FIXTURE_DESCRIPTOR, capability: 'live_example', compensation: 'manual', simulation: false, simulationNote: undefined, externalCalls: 'Для каждого фильма делается один запрос к источнику метаданных.', cta: 'Обновить метаданные'}]);
const livePreview = previewAction(createRegistry([live]), request({capability: 'live_example'}), observation);
const liveModel = presentPreview(livePreview, liveDescriptors, context);
assert.equal(liveModel.explainable, true);
assert.equal(liveModel.status.headline, 'Можно подтвердить');
assert.equal(liveModel.change.simulation, null);
assert.equal(liveModel.confirm.cta, 'Обновить метаданные (2 тестовых фильма)');
assert.ok(liveModel.risks.includes('Для каждого фильма делается один запрос к источнику метаданных.'));
assert.ok(liveModel.risks.includes(ACTION_COMPENSATION_COPY.manual));

// 6. Russian counts.
const noun = FIXTURE_DESCRIPTOR.noun;
assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(count => actionCount(count, noun).split(' ').slice(1).join(' ')),
  ['тестовый фильм', 'тестовых фильма', 'тестовых фильма', 'тестовых фильмов', 'тестовых фильмов', 'тестовых фильмов', 'тестовых фильмов', 'тестовый фильм', 'тестовых фильма', 'тестовых фильмов', 'тестовый фильм', 'тестовых фильмов']);
assert.deepEqual([1, 2, 11, 21].map(count => actionCountOf(count, noun)), ['1 тестового фильма', '2 тестовых фильмов', '11 тестовых фильмов', '21 тестового фильма']);
console.log('Admin actions presentation: exhaustive code copy, descriptor contract, fail-closed explanations, receipts and Russian counts passed');
