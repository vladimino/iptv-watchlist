// AIR-465: the synthetic-at-scale fixture. The E6 layout is checked as counts (no sqlite). A small profile is written and run through the real M2 harness: foreign keys, departed films outside the watchlist, their absence and their return, and a report that holds counts only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {E6_TARGETS,buildLayout,layoutDigest,measureSynthetic,writeSynthetic} from '../scripts/epg-producer-m2b-synthetic.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-m2b-synthetic-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});

const SMALL={
 seed:'m2b-synthetic-small',
 clock:'2026-11-14T00:00:00.000Z',
 films:24,persons:80,credits:98,dimensions:30,
 watchlistFilms:6,metadataRows:8,syncRows:8,
 creditedPersons:10,watchlistCreditRows:16,watchlistCreditMin:2,watchlistCreditMax:4,
 elevatedFilms:6,elevatedCreditRows:14,elevatedPersons:8,elevatedCreditMin:2,elevatedCreditMax:4,
 departedSteady:2,departedElevated:2,absentDeparted:2,
 creditCap:50,largeCreditFilms:1,largeCreditSize:50,restCreditMax:6,
};

// 1. The E6 layout hits the sanitized aggregates and stays inside the credit-unit cap. Two builds are the same plan.
{
 const first=buildLayout(E6_TARGETS),second=buildLayout(E6_TARGETS);
 assert.equal(layoutDigest(first),'af5f4d6094ad283ee5ca688da8ba718c789a267977dc121bb25fe243fd4f4ea1');
 assert.equal(layoutDigest(first),layoutDigest(second));
 const s=first.summary;
 assert.equal(s.films,10044);
 assert.equal(s.persons,53623);
 assert.equal(s.credits,107064);
 assert.equal(s.dimensions,34936);
 assert.equal(s.watchlistFilms,391);
 assert.equal(s.metadataRows,399);
 assert.equal(s.syncRows,399);
 assert.equal(s.watchlistCreditRows,8600);
 assert.equal(s.watchlistPersons,6452);
 assert.equal(s.watchlistCreditMin,11);
 assert.equal(s.watchlistCreditMax,26);
 assert.equal(s.departedSteady,6);
 assert.equal(s.productionSample,false);
 assert.equal(s.modelled,true);
 assert.ok(s.maxCreditsPerFilm<=50);
 assert.ok(s.zeroCreditFilms>0);
 assert.ok(s.nullTitles>0);
 assert.ok(s.nullYearMetadata>0);
 assert.ok(s.missingExternalIds>0);
 assert.ok(s.personsWithoutCredits>0);
 assert.equal(s.elevatedFilms,391);
 const cohorts=new Set(first.films.map(film=>film.cohort));
 assert.deepEqual([...cohorts].sort(),['elevated','rest','watchlist']);
 const departed=new Set(first.departedIds);
 assert.equal(departed.size,6);
 for(const film of first.films){
  if(film.cohort==='watchlist')assert.equal(departed.has(film.id),false);
  assert.ok(film.credits.length<=50);
 }
 assert.ok(first.departedIds.every(id=>first.elevatedIds.includes(id)));
}

// 2. A small file runs through the real harness. Steady units are no-ops. Departed films are outside the watchlist. Absence is unresolved. The elevated run puts those departed films back on the watchlist.
{
 const file=path.join(root,'small.sqlite');
 const written=writeSynthetic(file,SMALL);
 assert.equal(written.ok,true);
 assert.equal(written.counts.foreign_key_violations,0);
 const measured=await measureSynthetic(file,SMALL,{root});
 assert.equal(measured.ok,true);
 assert.equal(measured.productionSample,false);
 assert.equal(measured.personState,'unmeasured');
 assert.equal(measured.steady.volume.films,6);
 assert.equal(measured.steady.volume.departed,2);
 assert.equal(measured.steady.volume.personStateUnits,'unmeasured');
 assert.equal(measured.steady.report.writes,0);
 assert.equal(measured.steady.report.changed,0);
 assert.equal(measured.steady.report.fingerprint.complete,true);
 assert.equal(measured.steady.report.byKind.film_facts.units,8);
 assert.equal(measured.steady.report.byKind.film_facts.noop,8);
 assert.equal(measured.steady.report.byKind.person_state,undefined);
 assert.ok(measured.steady.report.byKind.person_mutation.units>0);
 assert.ok(measured.steady.report.byKind.film_credits.units>0);
 assert.equal(measured.steady.report.d1ReadsPerUnit.total>0,true);
 assert.ok(measured.steady.report.planMs>=0);
 assert.equal(measured.absent.report.fingerprint.complete,false);
 assert.equal(measured.absent.report.fingerprint.missing.unresolved_release,2);
 assert.equal(measured.absent.report.byKind.film_facts.units,4);
 assert.equal(measured.absent.report.byKind.film_facts.noop,2);
 assert.equal(measured.elevated.returnedSteadyDeparted,2);
 assert.ok(measured.elevated.volume.films>measured.steady.volume.films);
 assert.ok(measured.elevated.volume.personRows>measured.steady.volume.personRows);
 assert.equal(measured.elevated.report.changed,0);
 assert.equal(measured.elevated.report.writes,0);
 assert.equal(measured.elevated.watchlistManifest.consistent,true);
 assert.equal(measured.elevated.watchlistManifest.rowCount,12);
 assert.equal(measured.elevated.watchlistManifest.maxRowid,measured.elevated.watchlistManifest.recordedMaxRowid);
 const stress=measured.creditCapStress;
 assert.equal(stress.e6Cohort,false);
 assert.equal(stress.creditsPerFilm,50);
 assert.equal(stress.volume.films,1);
 assert.equal(stress.volume.departed,0);
 assert.equal(stress.volume.creditFilms,1);
 assert.equal(stress.volume.personRows,50);
 assert.equal(stress.watchlistManifest.consistent,true);
 assert.equal(stress.watchlistManifest.rowCount,1);
 assert.equal(stress.report.changed,0);
 assert.equal(stress.report.writes,0);
 assert.equal(stress.report.byKind.film_facts.units,1);
 assert.equal(stress.report.byKind.film_facts.noop,1);
 assert.equal(stress.report.byKind.film_credits.units,1);
 assert.equal(stress.report.byKind.film_credits.noop,1);
 assert.equal(stress.report.byKind.person_mutation.units,50);
 assert.equal(stress.report.byKind.person_mutation.noop,50);
 assert.equal(stress.report.byKind.person_state,undefined);
 assert.equal(stress.report.d1ReadsPerUnit.total,1*9+50*4+1*4);
 assert.equal(JSON.stringify(measured).includes('film:'),false);
 assert.equal(JSON.stringify(measured).includes('person:'),false);
 assert.equal(JSON.stringify(measured).includes('Synthetic'),false);
}

// 3. The generator does not reach the network.
{
 const source=fs.readFileSync('scripts/epg-producer-m2b-synthetic.mjs','utf8');
 assert.equal(/\bfetch\s*\(/.test(source),false);
 assert.equal(source.includes('cloudflare'),false);
 assert.equal(source.includes('workers.dev'),false);
}

console.log('epg-producer-m2b-synthetic: ok');
