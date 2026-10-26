// Letterboxd export reconciliation with invented data only: no real title, code or rating appears here.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CsvError,parseCsv,parseExport,parseRating} from '../src/letterboxd-export.js';
import {buildIndex,lidHypothesis,matchExport,normTitle} from '../src/letterboxd-match.js';
import {reconcile} from '../scripts/letterboxd-reconcile.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const scratch=await mkdtemp(path.join(os.tmpdir(),'lbx-reconcile-'));
const repoRoot=path.resolve('.');

// CSV: quoting, escaped quotes, CRLF, BOM, embedded newline, malformed input.
assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'),[['a','b'],['x, y','say "hi"']]);
assert.deepEqual(parseCsv('a\n"two\nlines"\n\n'),[['a'],['two\nlines']]);
assert.deepEqual(parseCsv('a,,""\n'),[['a','','']]);
assert.throws(()=>parseCsv('a\n"open'),CsvError);
assert.throws(()=>parseCsv('a\nb"c'),CsvError);
assert.throws(()=>parseCsv('a\n"b"c'),CsvError);
for(const [value,expected] of [['4.5',4.5],['0.5',0.5],['5',5],['0',null],['5.5',null],['4.25',null],['',null],['four',null]])assert.equal(parseRating(value),expected);
assert.equal(normTitle('Ёлка, The!'),'елка the');

// Invented export. Codes are distinctive so their absence from the report can be checked.
const film={
 alpha:['Q7a1','Alpha, The',2001],quote:['Q7b2','Say "Hi"',1999],remake:['Q7c3','Remake Story',2003],remakeNoYear:['Q7d4','Remake Story',''],
 near:['Q7e5','Near Year Film',2010],nearSignal:['Q7f6','Near Year Second',2015],alias:['Q7g7','Shared Alias Film',2005],none:['Q7h8','Nobody Knows This',1980],
 unrated:['Q7i9','Unrated Picture',2020],wrongYear:['Q7j0','Wrong Year Picture',1950],multiline:['Q7k1','Line\nBreak Film',1990],want:['Q7n4','Want To See Film',2022],
};
const uri=code=>'https://boxd.it/'+code;
const q=value=>'"'+String(value).replaceAll('"','""')+'"';
const line=(date,[code,name,year],...extra)=>[date,q(name),year,uri(code),...extra].join(',');
const watched=['Date,Name,Year,Letterboxd URI',
 ...['alpha','quote','remake','remakeNoYear','near','nearSignal','alias','none','unrated','wrongYear','multiline'].map(key=>line('2024-01-02',film[key])),
 line('2024-01-02',film.alpha),
 '2024-01-03,Bad Link,2000,https://letterboxd.com/film/bad-link/',
 '2024-01-03,Bad Year,19x9,https://boxd.it/Q7z9',
].join('\r\n')+'\r\n';
const rated={alpha:'4.5',quote:'3',remake:'4',remakeNoYear:'2',near:'3',nearSignal:'3.5',alias:'5',none:'1',wrongYear:'2',multiline:'0.5'};
const ratings=['Date,Name,Year,Letterboxd URI,Rating',
 ...Object.entries(rated).map(([key,rating])=>line('2024-01-04',film[key],rating)),
 line('2024-01-04',['Q7l2','Quarter Star',2001],'4.25'),
 line('2024-01-04',['Q7m3','Conflicted Rating',2002],'3'),
 line('2024-01-04',['Q7m3','Conflicted Rating',2002],'4'),
].join('\n')+'\n';
const watchlist=['Date,Name,Year,Letterboxd URI',line('2024-01-05',film.alpha),line('2024-01-05',film.want)].join('\n')+'\n';
const diary=['Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date','2024-01-06,"Diary Entry",2001,https://boxd.it/Q7x1,4,,,2024-01-05'].join('\n')+'\n';

const parsed=parseExport({watched,ratings,watchlist,diary});
assert.deepEqual(Object.fromEntries(Object.entries(parsed.sets).map(([name,codes])=>[name,codes.length])),{watched:11,rated:10,watchedUnrated:1,ratedNotWatched:0,watchlist:2,watchlistWatched:1});
assert.deepEqual(parsed.sets.watchedUnrated,['Q7i9']);
assert.deepEqual(parsed.files.watched,{present:true,records:14,valid:12,invalid:{invalid_uri:1,invalid_year:1},duplicates:1,conflicts:0,missingYear:1});
assert.deepEqual(parsed.files.ratings.invalid,{invalid_rating:1});
assert.equal(parsed.files.ratings.conflicts,1);
assert.equal(parsed.files.diary.auxiliary,true);
assert.equal(parsed.films.find(row=>row.code==='Q7b2').name,'Say "Hi"');
assert.equal(parsed.films.find(row=>row.code==='Q7a1').name,'Alpha, The');
assert.equal(parsed.films.find(row=>row.code==='Q7k1').name,'Line\nBreak Film');
assert.deepEqual(parsed.invalidRows.map(row=>row.reason).sort(),['invalid_rating','invalid_uri','invalid_year']);
assert.throws(()=>parseExport({watched:'Date,Name,Year\n'}),/lacks the column Letterboxd URI/);
assert.ok(parseExport({watched}).notes.includes('missing_file:ratings.csv'));

// Invented snapshot objects.
const objects={
 'watchlist.json':{updatedAt:'2024-02-01',films:[
  {id:'Q7a1',title:'Альфа',original:'Alpha, The',year:2001,url:'https://letterboxd.com/film/invented-alpha/',aliases:['Alpha, The']},
  {id:'zz9',title:'Want To See Film',original:'Want To See Film',year:2022,url:'https://letterboxd.com/film/invented-want/'},
 ]},
 'programme.json':{runId:'run-test',films:[{id:'Q7a1',title:'Альфа',original:'Alpha, The',year:2001,tmdbId:null}]},
 'metadata.json':{
  Q7b2:{id:'Q7b2',title:'Say "Hi"',original:'Say "Hi"',year:1999,tmdbId:'500',aliases:['Say "Hi"']},
  Q7j0:{id:'Q7j0',title:'Wrong Year Picture',original:'Wrong Year Picture',year:2020,tmdbId:'900'},
 },
 'epg/discovered-films.json':{
  tmdb_500:{id:'tmdb_500',tmdbId:'500',canonicalIdentity:'tmdb:500',title:'Скажи привет',original:'Say "Hi"',year:1999},
  tmdb_601:{id:'tmdb_601',tmdbId:'601',canonicalIdentity:'tmdb:601',title:'Remake Story',original:'Remake Story',year:1960},
  tmdb_602:{id:'tmdb_602',tmdbId:'602',canonicalIdentity:'tmdb:602',title:'Remake Story',original:'Remake Story',year:2003},
  tmdb_700:{id:'tmdb_700',tmdbId:'700',canonicalIdentity:'tmdb:700',title:'Near Year Film',original:'Near Year Film',year:2011},
  tmdb_701:{id:'tmdb_701',tmdbId:'701',canonicalIdentity:'tmdb:701',title:'Near Year Second',original:'Near Year Second',year:2014},
  tmdb_801:{id:'tmdb_801',tmdbId:'801',canonicalIdentity:'tmdb:801',title:'Другое',original:'Other Original',aliases:['Shared Alias Film'],year:2005},
  tmdb_802:{id:'tmdb_802',tmdbId:'802',canonicalIdentity:'tmdb:802',title:'Shared Alias Film',original:'Shared Alias Film',year:2005},
  'nobody|1980':{id:'nobody|1980',tmdbId:null,title:'Nobody Knows This',year:1980},
 },
 'enrichment/view-index.json':{Q7a1:{actualRating:4.5},tmdb_602:{actualRating:4},tmdb_701:{actualRating:3.5}},
 'enrichment/ratings/published.json':{generationId:'gen-1',phase:'published',projected:true},
 'enrichment/ratings/generations/gen-1.json':{schemaVersion:1,generationId:'gen-1',ratings:{Q7a1:4.5,Q7i9:null,Q7b2:3}},
};
async function writeSnapshot(directory,values,overrides={}){
 await mkdir(path.join(directory,'objects'),{recursive:true});
 const entries=[];
 for(const [key,value] of Object.entries(values)){const bytes=Buffer.from(JSON.stringify(value)),file='objects/'+sha256(Buffer.from(key))+'.bin';await writeFile(path.join(directory,file),bytes);entries.push({key,file,size:bytes.length,sha256:sha256(bytes)});}
 await writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,sourceSiteId:null,sourceOrigin:null,source:{kind:'cloudflare-r2-s3',bucket:'iptv',accountId:'0'.repeat(32),readOnly:true},status:'consistent_fenced',noGoReasons:[],fence:{ok:true,keys:[]},changes:[],baselineIdentity:{programmeRunId:'run-test'},objects:entries,...overrides}));
 return entries;
}

// Matcher directly.
const index=buildIndex({watchlist:objects['watchlist.json'],programme:objects['programme.json'],metadata:objects['metadata.json'],catalog:objects['epg/discovered-films.json'],viewIndex:objects['enrichment/view-index.json'],ratings:objects['enrichment/ratings/generations/gen-1.json']});
assert.equal(index.summary.verifiedCatalogRecords,7);
const matches=matchExport(parsed.films,index),by=Object.fromEntries(matches.map(row=>[row.code,row]));
assert.deepEqual(matches.map(row=>row.code),[...matches.map(row=>row.code)].sort());
assert.equal(by.Q7a1.status,'accepted');assert.equal(by.Q7a1.method,'lid_exact');assert.equal(by.Q7a1.evidence.titleYear,'agree');assert.equal(by.Q7a1.evidence.rating,'agree');
assert.equal(by.Q7b2.method,'tmdb_verified');assert.deepEqual(by.Q7b2.catalogIds,['tmdb_500']);assert.equal(by.Q7b2.tmdbId,'500');
assert.equal(by.Q7i9.method,'lid_exact');assert.equal(by.Q7i9.evidence.rating,'unknown');
assert.equal(by.Q7j0.status,'conflict');assert.equal(by.Q7j0.reason,'stored_year_disagrees');
assert.equal(by.Q7c3.status,'accepted');assert.equal(by.Q7c3.method,'title_year');assert.deepEqual(by.Q7c3.catalogIds,['tmdb_602']);assert.deepEqual(by.Q7c3.evidence.signals,['rating_agrees']);
assert.equal(by.Q7d4.status,'ambiguous');assert.equal(by.Q7d4.reason,'missing_year_multiple_targets');assert.deepEqual(by.Q7d4.candidates,['catalog:tmdb_601','catalog:tmdb_602']);
assert.equal(by.Q7e5.status,'candidate');assert.equal(by.Q7e5.reason,'no_second_signal');assert.equal(by.Q7e5.evidence.yearDelta,1);
assert.equal(by.Q7f6.status,'accepted');assert.equal(by.Q7f6.evidence.yearDelta,1);
assert.equal(by.Q7g7.status,'ambiguous');assert.equal(by.Q7g7.reason,'multiple_targets');
assert.equal(by.Q7h8.status,'unmatched');assert.equal(by.Q7h8.reason,'no_stored_title');
assert.equal(by.Q7k1.status,'unmatched');
assert.equal(by.Q7n4.status,'accepted');assert.equal(by.Q7n4.filmId,'zz9');assert.deepEqual(by.Q7n4.evidence.signals,['watchlist_member']);
assert.equal(by.Q7n4.basis,'title');
// Title and year alone never accept, even with an exact year.
const lone=matchExport([{code:'Q7p6',name:'Near Year Film',year:2011,inWatched:true,inRatings:false,inWatchlist:false}],index)[0];
assert.equal(lone.status,'candidate');
// A different stored rating blocks acceptance.
const disagree=matchExport([{code:'Q7p7',name:'Near Year Second',year:2014,rating:1,inWatched:true,inRatings:true,inWatchlist:false}],index)[0];
assert.equal(disagree.status,'candidate');assert.equal(disagree.reason,'rating_disagrees');
// A stored id with two TMDB ids is a conflict, not a match.
const conflicted=buildIndex({watchlist:{films:[{id:'Q7q8',title:'Two Ids',year:2000,tmdbId:'1'}]},metadata:{Q7q8:{id:'Q7q8',title:'Two Ids',year:2000,tmdbId:'2'}}});
assert.equal(matchExport([{code:'Q7q8',name:'Two Ids',year:2000}],conflicted)[0].reason,'stored_tmdb_conflict');
assert.equal(lidHypothesis(matches,index).verdict,'mixed');
// Hypothesis verdicts on minimal indexes.
const lidOnly=buildIndex({watchlist:{films:[{id:'Q7r1',title:'Match Me',year:2000}]},ratings:{ratings:{Q7r1:3}}});
assert.equal(lidHypothesis(matchExport([{code:'Q7r1',name:'Match Me',year:2000,rating:3}],lidOnly),lidOnly).verdict,'supported');
assert.equal(lidHypothesis(matchExport([{code:'Q7s2',name:'Match Me',year:2000,rating:3}],lidOnly),lidOnly).verdict,'refuted');
assert.equal(lidHypothesis(matchExport([{code:'Q7s2',name:'Match Me',year:2000}],buildIndex({})),buildIndex({})).verdict,'inconclusive');

// CLI end to end.
const exportDir=path.join(scratch,'export'),snapshotDir=path.join(scratch,'snapshot');
await mkdir(exportDir,{recursive:true});
for(const [name,text] of Object.entries({'watched.csv':watched,'ratings.csv':ratings,'watchlist.csv':watchlist,'diary.csv':diary,'profile.csv':'Username\nprivate-invented\n'}))await writeFile(path.join(exportDir,name),text);
await writeSnapshot(snapshotDir,objects);
const cli=args=>spawnSync(process.execPath,['scripts/letterboxd-reconcile.mjs',...args],{encoding:'utf8'});
const names=[...Object.values(film).map(([,name])=>name),'Quarter Star','Conflicted Rating','Diary Entry','private-invented'];
const codes=[...Object.values(film).map(([code])=>code),'Q7l2','Q7m3','Q7x1','zz9'];
function assertPrivate(text){
 for(const name of names)assert.ok(!text.includes(name)&&!text.includes(JSON.stringify(name).slice(1,-1)),'name leaked');
 for(const code of codes)assert.ok(!text.includes(code),'code leaked');
 assert.ok(!text.includes('boxd.it')&&!text.includes('letterboxd.com/film'),'uri leaked');
}

const outA=path.join(scratch,'out-a'),outB=path.join(scratch,'out-b');
const runA=cli(['--export',exportDir,'--snapshot',snapshotDir,'--output',outA]);
assert.equal(runA.status,0,runA.stderr);
assertPrivate(runA.stdout);
const runB=cli(['--export',exportDir,'--snapshot',snapshotDir,'--output',outB]);
assert.equal(runB.status,0,runB.stderr);
const reportText=await readFile(path.join(outA,'report.json'),'utf8');
assert.equal(reportText,await readFile(path.join(outB,'report.json'),'utf8'),'report is deterministic');
assert.equal(await readFile(path.join(outA,'matches.jsonl'),'utf8'),await readFile(path.join(outB,'matches.jsonl'),'utf8'),'matches are deterministic');
assertPrivate(reportText);
const report=JSON.parse(reportText);
assert.equal(report.matching.blocked,null);
assert.deepEqual(report.export.sets,{watched:11,rated:10,watchedUnrated:1,ratedNotWatched:0,watchlist:2,watchlistWatched:1});
assert.deepEqual(report.matching.byStatus,{accepted:6,candidate:1,ambiguous:2,conflict:1,unmatched:2});
assert.deepEqual(report.matching.acceptedByMethod,{lid_exact:2,tmdb_verified:1,title_year:3});
assert.equal(report.matching.bySet.watchedUnrated.acceptedByMethod.lid_exact,1);
assert.equal(report.matching.bySet.watchlistWatched.total,1);
assert.equal(report.matching.lidHypothesis.verdict,'mixed');
assert.deepEqual(report.matching.snapshot.missingKeys,[]);
assert.equal(report.export.invalidRows,3);
const rows=(await readFile(path.join(outA,'matches.jsonl'),'utf8')).trim().split('\n').map(text=>JSON.parse(text));
assert.equal(rows.filter(row=>row.type==='match').length,12);
assert.equal(rows.filter(row=>row.type==='invalid_row').length,3);
assert.ok(rows.some(row=>row.name==='Alpha, The'),'private rows keep names');

// Without a snapshot: parse-level aggregates and a blocked matching section.
const outC=path.join(scratch,'out-c'),runC=cli(['--export',exportDir,'--output',outC]);
assert.equal(runC.status,0,runC.stderr);
const blocked=JSON.parse(await readFile(path.join(outC,'report.json'),'utf8'));
assert.deepEqual(blocked.matching,{blocked:'snapshot_missing'});
assert.equal(blocked.export.sets.watched,11);
assertPrivate(runC.stdout+JSON.stringify(blocked));

// Output inside the repository, relative paths and missing arguments are refused before anything is written.
const inside=path.join(repoRoot,'tmp-letterboxd-out');
const runD=cli(['--export',exportDir,'--output',inside]);
assert.equal(runD.status,2);assert.match(runD.stderr,/outside the Git repository/);assert.equal(existsSync(inside),false);
await assert.rejects(reconcile({exportDir,outputDir:path.join(repoRoot,'docs','x')}),/outside the Git repository/);
assert.equal(cli(['--export',exportDir,'--output','relative/out']).status,2);
assert.equal(cli(['--export',exportDir]).status,2);
assert.equal(cli(['--export',path.join(repoRoot,'tests'),'--output',path.join(scratch,'out-e')]).status,2);

// A snapshot that is not a fenced consistent cut, or whose bytes differ from the manifest, is refused.
const noGo=path.join(scratch,'snapshot-no-go');await writeSnapshot(noGo,objects,{status:'no_go',noGoReasons:['source_changed']});
const runF=cli(['--export',exportDir,'--snapshot',noGo,'--output',path.join(scratch,'out-f')]);
assert.equal(runF.status,3);assert.equal(existsSync(path.join(scratch,'out-f','report.json')),false);
const tampered=path.join(scratch,'snapshot-tampered'),entries=await writeSnapshot(tampered,objects);
await writeFile(path.join(tampered,entries.find(entry=>entry.key==='watchlist.json').file),'{"films":[]}');
assert.equal(cli(['--export',exportDir,'--snapshot',tampered,'--output',path.join(scratch,'out-g')]).status,3);
// Absent snapshot keys are reported, not invented.
const partial=path.join(scratch,'snapshot-partial');await writeSnapshot(partial,{'watchlist.json':objects['watchlist.json']});
const runH=cli(['--export',exportDir,'--snapshot',partial,'--output',path.join(scratch,'out-h')]);
assert.equal(runH.status,0,runH.stderr);
const partialReport=JSON.parse(await readFile(path.join(scratch,'out-h','report.json'),'utf8'));
assert.ok(partialReport.matching.snapshot.missingKeys.includes('epg/discovered-films.json'));
assert.ok(partialReport.notes.includes('snapshot_missing_key:metadata.json'));
// A malformed CSV stops the run without output.
const badExport=path.join(scratch,'bad-export');await mkdir(badExport);await writeFile(path.join(badExport,'watched.csv'),'Date,Name,Year,Letterboxd URI\n2024-01-01,"open,2000,https://boxd.it/Q7t1\n');
const runI=cli(['--export',badExport,'--output',path.join(scratch,'out-i')]);
assert.equal(runI.status,1);assert.match(runI.stderr,/watched\.csv: Unterminated/);assert.equal(existsSync(path.join(scratch,'out-i')),false);

await rm(scratch,{recursive:true,force:true});
console.log('Letterboxd reconciliation tests passed.');
