// The Worker modules the archive preview route needs, in one vm context, over the caller's bucket, console and fetch.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../../scripts/bundle-scope.mjs';

export function loadArchiveWorker({now, console: logger, fetch}) {
  const FrozenDate = class extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}};
  const context = vm.createContext({Response, Request, Headers, URL, URLSearchParams, AbortSignal, AbortController, Date: FrozenDate, Intl, Map, Set, JSON, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, atob, btoa, crypto: webcrypto, console: logger, setTimeout, structuredClone, Number, Math,
    FormData, File, Blob, ReadableStream, DecompressionStream,
    ASSETS: {}, INITIAL_PERSONAL_RATINGS: {}, FILM_TITLE_DICTIONARY: [], PERSON_NAME_DICTIONARY: [], fetch});
  for (const file of ['src/domain/film-person.js', 'src/domain/prediction-versions.js', 'src/domain/film-history.js', 'src/domain/prediction-quality.js', 'src/domain/profile-impact.js', 'src/domain/prediction-compatibility.js', 'src/domain/fingerprint-compatibility.js', 'src/domain/scored-resolution.js', 'src/domain/resolution-acceptance.js', 'src/sources.js', 'src/ratings-seed.js', 'src/discovery.js', 'src/letterboxd-facts.js', 'src/enrichment.js', 'src/letterboxd-diary.js', 'src/migration-export.js', 'src/filter-presets.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext(scoped('src/domain/admin-query.js', 'AdminQuery'), context);
  vm.runInContext(fs.readFileSync('src/admin/read.js', 'utf8'), context);
  vm.runInContext(scoped('src/domain/data-health.js', 'DataHealth'), context);
  for (const [file, name] of [['src/letterboxd-export.js', 'LetterboxdExport'], ['src/letterboxd-match.js', 'LetterboxdMatch'], ['src/domain/letterboxd-archive-zip.js', 'LetterboxdArchiveZip'], ['src/domain/letterboxd-archive-preview.js', 'LetterboxdArchivePreview'], ['src/domain/letterboxd-archive-apply.js', 'LetterboxdArchiveApply'], ['src/domain/admin-actions.js', 'AdminActions']]) vm.runInContext(scoped(file, name), context);
  vm.runInContext(fs.readFileSync('src/admin/letterboxd-archive.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/admin/letterboxd-archive-apply.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('src/worker.js', 'utf8').replace('export default', 'globalThis.worker='), context);
  return {context, worker: context.worker, facts: vm.runInContext('LetterboxdFacts', context), resetCache: () => vm.runInContext('ADMIN_SNAPSHOT_CACHE=null', context)};
}
