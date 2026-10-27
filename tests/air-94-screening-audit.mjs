import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {audit,loadSnapshot} from '../scripts/air-94-screening-audit.mjs';

// Synthetic snapshot in the r2-snapshot-export layout; aggregates must contain counts only.
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'air-94-audit-')),objects=[];
const put=(key,value)=>{const file='objects/'+objects.length+'.bin';fs.mkdirSync(path.join(dir,'objects'),{recursive:true});fs.writeFileSync(path.join(dir,file),JSON.stringify(value));objects.push({key,file});};
const now=Date.UTC(2026,9,26,12),show={channelId:'c',start:now,end:now+3600000};
const item=(key,title,extra={})=>({key,title,shows:[show],seenInLatestSnapshot:true,...extra});
put('epg/published-generation.json',{programmeRunId:'g1',phase:'published'});
put('epg/generations/g1/programme.json',{films:[{title:'Open Season 3',aliases:['Show Boat']}]});
put('epg/generations/g1/discovery-latest.json',{programmeRunId:'g1',updatedAt:new Date(now).toISOString(),filteredNonMovies:9,rawCandidates:40,items:[
 item('sw|2005','Star Wars: Episode 3 - Revenge of the Sith'),
 item('bb|','Breaking Bad S01E01'),
 item('code|','Пример 2022 10 эпизодов s01ep04'),
 item('ts|','т/с Пример'),
 item('verified|','Пример Сезон 1 Серия 2'),
]});
put('epg/discovery-resolution.json',{'sw|2005':{status:'excluded_nonfilm',reason:'episode_label'},'bb|':{status:'excluded_nonfilm',reason:'episode_label'},'verified|':{status:'verified',tmdbId:'1'}});
put('epg/generations/g1/discovered-films.json',{});
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({objects}));

const {report,privateRows}=audit(loadSnapshot(dir));
assert.equal(report.rawFeedInSnapshot,false);assert.equal(report.aggregateFilteredNonMovies,9);
assert.deepEqual({...report.control.legacy},{episode_label:1,show_label:1});assert.deepEqual({...report.control.fixed},{});
// The verified episode-form row counts as prevented: a verified identity outranks the title screen.
assert.equal(report.ledger.prevented.episode_label,2);assert.equal(report.ledger.added.episode_label,1);
assert.equal(report.ledger.staleExcluded.episode_label,1);assert.equal(report.ledger.staleExcludedCurrent,1);assert.equal(report.ledger.addedCurrentActionable,1);
assert.equal(report.episodeCode.codeCandidatesActionableLegacy,1);assert.equal(report.episodeCode.codeCandidatesActionableFixed,0);
assert(!JSON.stringify(report).includes('Star Wars'));assert(privateRows.some(row=>row.title.includes('Star Wars')));
fs.rmSync(dir,{recursive:true,force:true});
console.log('AIR-94 screening audit: legacy vs current rule aggregates, stale exclusions, episode-code leaks and title-free report passed');
