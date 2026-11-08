// AIR-388 (ADR 0104): the inferred identity policy of a personal Letterboxd export. Invented films only; no network, no R2, no D1.
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {deflateRawSync} from 'node:zlib';
import {crc32} from '../src/letterboxd-zip.js';
import {INFERRED_METHOD,INFERRED_STATUS,METHODS,REVIEW_REASONS,STATUSES,buildIndex,matchExport} from '../src/letterboxd-match.js';
import {plan,planItem,remote,unlinkFilm} from '../scripts/letterboxd-baseline-import.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const by=(rows,code)=>rows.find(row=>row.code===code);

// ---- The matcher ----
const film=(id,original,year,extra={})=>[String(id),{id:'tmdb_'+id,tmdbId:String(id),canonicalIdentity:'tmdb:'+id,title:'Localized '+id,original,year,aliases:[],...extra}];
const catalog=Object.fromEntries([
 film(101,'Invented One',2001,{aliases:['Famous Alias']}),
 film(102,'Twin Title',2005),film(103,'Twin Title',2005),
 film(104,'Drift Film',2010),
 film(105,'Linked Elsewhere',2012),
 film(106,'Same Code',2013),
 film(107,'Dup Claim',2014),
 film(108,'Taken By Code',2015),
 film(109,'Original Nine',2016,{aliases:['Export Name Nine']}),
 film(110,'Remake Film',1990),film(111,'Remake Film',2009),
 film(120,'Namesake',2000),film(121,'Namesake',2001),
 film(122,'Same Twin',2003),film(123,'Same Twin',2003),
]);
const metadata={Vv1:{id:'Vv1',title:'Taken By Code',original:'Taken By Code',year:2015,tmdbId:'108'},Nn1:{id:'Nn1',title:'No Tmdb',original:'No Tmdb',year:2017}};
const factLinks={'letterboxd:OtherLid':'lb-1','tmdb:105':'lb-1','letterboxd:Ll6':'lb-2','tmdb:106':'lb-2','letterboxd:Cx9':'lb-3','tmdb:999':'lb-3'};
const index=buildIndex({catalog,metadata,factLinks});
const exportFilm=(code,name,year,extra={})=>({code,name,year,inWatched:true,inRatings:false,inWatchlist:false,...extra});
const films=[
 exportFilm('Aa1','Invented One',2001),            // unique original + same year
 exportFilm('Aa2','Twin Title',2005),              // two TMDB movies
 exportFilm('Aa3','Drift Film',2011),              // year differs by one
 exportFilm('Aa4','Famous Alias',2001),            // alias only
 exportFilm('Aa5','Linked Elsewhere',2012),        // TMDB already linked to another Letterboxd id
 exportFilm('Ll6','Same Code',2013),               // the same code is the link: no contradiction
 exportFilm('Aa7','Dup Claim',2014),               // two export codes, one movie
 exportFilm('Aa8','Dup Claim',2014),
 exportFilm('Vv1','Taken By Code',2015),           // accepted by its stored id
 exportFilm('Ww2','Taken By Code',2015),           // a second code for an already accepted movie
 exportFilm('Aa9','Export Name Nine',2016),        // alias only, the original differs
 exportFilm('Mm1','No Tmdb',2017),                 // stored film without a TMDB id
 exportFilm('Mm2','Invented One',null),            // no year at all
 exportFilm('Cx9','Remake Film',2009),             // this code is linked to another TMDB id
 exportFilm('Rm1','Remake Film',1990),             // the remake pair stays apart by year
 exportFilm('Zz0','Nothing Like It',2020),         // no stored title
 exportFilm('Nm1','Namesake',2000),                // exact year wins over a namesake one year later
 exportFilm('Nm2','Namesake',2001),                // and the other way round
 exportFilm('Tw1','Same Twin',2003),               // two movies, same original title and year: still ambiguous
];
const off=matchExport(films,index),on=matchExport(films,index,{inferred:true});

// The policy is off by default: not one `inferred` row, every title match is the old candidate.
assert.ok(off.every(row=>row.status!=='inferred'));
assert.equal(by(off,'Aa1').status,'candidate');assert.equal(by(off,'Aa1').reason,'identity_unverified');
// With the policy on, `accepted` rows are exactly what they were.
assert.deepEqual(on.filter(row=>row.status==='accepted'),off.filter(row=>row.status==='accepted'));
assert.equal(by(on,'Vv1').status,'accepted');

const inferred=by(on,'Aa1');
assert.equal(inferred.status,'inferred');assert.equal(inferred.method,'title_year_unique');assert.equal(inferred.tmdbId,'101');
assert.equal(inferred.evidence.identity,'inferred');assert.equal(inferred.evidence.basis,'original_title_exact_year_unique');assert.equal(inferred.reason,null);
assert.equal(INFERRED_STATUS,'inferred');assert.equal(INFERRED_METHOD,'title_year_unique');
// The two lists every existing report is built from keep their exact keys.
assert.deepEqual([...STATUSES],['accepted','provisional','candidate','ambiguous','conflict','unmatched']);assert.deepEqual([...METHODS],['lid_exact','tmdb_verified','title_year']);

const review=(code,reason)=>{const row=by(on,code);assert.equal(row.status,'candidate',code);assert.equal(row.reason,reason,code);assert.ok(REVIEW_REASONS.includes(reason)||['missing_year','identity_unverified'].includes(reason),reason);};
assert.equal(by(on,'Aa2').status,'ambiguous');
review('Aa3','year_drift');
review('Aa4','alias_title_only');
review('Aa5','tmdb_linked_elsewhere');
review('Aa7','tmdb_duplicate_in_export');review('Aa8','tmdb_duplicate_in_export');
review('Ww2','tmdb_already_accepted');
review('Aa9','alias_title_only');
review('Mm1','no_tmdb_id');
review('Mm2','missing_year');
review('Cx9','tmdb_linked_elsewhere');
assert.equal(by(on,'Ll6').status,'inferred');           // linked to this very code
assert.equal(by(on,'Rm1').status,'inferred');assert.equal(by(on,'Rm1').tmdbId,'110');   // a remake is told apart by its year
assert.equal(by(on,'Zz0').status,'unmatched');
// Review blocker 2: an exact-year original-title match is chosen inside its own set, an adjacent-year namesake is no ambiguity.
assert.equal(by(on,'Nm1').status,'inferred');assert.equal(by(on,'Nm1').tmdbId,'120');
assert.equal(by(on,'Nm2').status,'inferred');assert.equal(by(on,'Nm2').tmdbId,'121');
assert.equal(by(on,'Tw1').status,'ambiguous');
// Legacy mode is unchanged: the same rows stay ambiguous in the +/-1 window.
assert.equal(by(off,'Nm1').status,'ambiguous');assert.equal(by(off,'Nm2').status,'ambiguous');
// A demoted row carries no inferred markers.
for(const code of ['Aa7','Aa8','Ww2'])assert.ok(!('identity' in by(on,code).evidence)&&!('basis' in by(on,code).evidence),code);
// Without the stored links the contradiction cannot be seen here; the commit-time alias conflict stays the authority.
assert.equal(by(matchExport(films,buildIndex({catalog,metadata}),{inferred:true}),'Aa5').status,'inferred');

// ---- The plan item ----
const wf={inWatched:true,inRatings:true,rating:3.5,inWatchlist:false,watchedDate:'2024-05-01'};
assert.deepEqual(planItem(wf,{status:'inferred',code:'Aa1',filmId:null,tmdbId:'101'}),{lid:'Aa1',tmdb:'101',facts:{watched:true,rating:3.5},effectiveOn:{watched:'2024-05-01'},identity:'inferred'});
const verified=planItem(wf,{status:'accepted',code:'Ab1',filmId:'Ab1',tmdbId:'949'});
assert.deepEqual(Object.keys(verified),['lid','tmdb','facts','effectiveOn']);   // the exact old shape: no identity key

// ---- The CLI switch is a plan-only switch ----
const cli=args=>spawnSync(process.execPath,['scripts/letterboxd-baseline-import.mjs',...args],{encoding:'utf8'});
assert.match(cli(['commit','--include-inferred']).stderr,/plan option/);
assert.match(cli(['plan','--include-inferred']).stderr,/plan needs --zip/);

// ---- plan() end to end ----
function zip(files){
 const locals=[],centrals=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const data=Buffer.from(text),body=deflateRawSync(data),nameBytes=Buffer.from(name),crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,nameBytes,body);centrals.push(central,nameBytes);offset+=30+nameBytes.length+body.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
function bucket(){
 const records=new Map(),etags=new Map();let revision=0,puts=0;
 return {records,get puts(){return puts;},
  async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){const c=options.onlyIf||{};if(c.etagDoesNotMatch==='*'&&records.has(key)||c.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts++;return {etag:etags.get(key)};}};
}
const ctx=vm.createContext({crypto:webcrypto,TextEncoder,console,Date,JSON,Map,Set,Response,Request,URL});
const F=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',ctx);
const workerFetch=env=>async(url,init)=>{const request=new Request(url,init),response=await F.handleBaselineRequest(request,env,new URL(url).pathname);return {ok:response.ok,status:response.status,json:()=>response.json()};};
const post=(env,kind,body)=>F.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,'/api/letterboxd/baseline/'+kind);

const scratch=await mkdtemp(path.join(os.tmpdir(),'iptv-lb-inferred-'));
try{
 const csv=(header,rows)=>header+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n';
 const exportFiles={
  'watched.csv':csv('Date,Name,Year,Letterboxd URI',[['2024-05-01','Invented One','2001','https://boxd.it/Aa1'],['2024-05-02','Drift Film','2011','https://boxd.it/Aa3'],['2024-05-03','Nobody Knows This','2001','https://boxd.it/Zz9'],['2024-05-04','Taken By Code','2015','https://boxd.it/Vv1']]),
  'ratings.csv':csv('Date,Name,Year,Letterboxd URI,Rating',[['2024-05-01','Invented One','2001','https://boxd.it/Aa1','4.5']]),
  'watchlist.csv':csv('Date,Name,Year,Letterboxd URI',[]),
  'diary.csv':csv('Date,Name,Year,Letterboxd URI,Rating,Watched Date',[]),
 };
 const zipPath=path.join(scratch,'letterboxd-demo-user-2026-11-08-13-55-utc.zip');await writeFile(zipPath,zip(exportFiles));
 const snapshotDir=path.join(scratch,'snapshot');await mkdir(path.join(snapshotDir,'objects'),{recursive:true});
 const values={'epg/discovered-films.json':catalog,'metadata.json':metadata,'letterboxd/facts/links.json':factLinks},entries=[];
 for(const [key,value] of Object.entries(values)){const bytes=Buffer.from(JSON.stringify(value)),file='objects/'+sha256(Buffer.from(key))+'.bin';await writeFile(path.join(snapshotDir,file),bytes);entries.push({key,file,size:bytes.length,sha256:sha256(bytes)});}
 await writeFile(path.join(snapshotDir,'manifest.json'),JSON.stringify({schemaVersion:1,source:{kind:'cloudflare-r2-s3',bucket:'iptv',readOnly:true},status:'consistent_fenced',noGoReasons:[],fence:{ok:true,keys:[]},changes:[],baselineIdentity:{programmeRunId:'run-test'},objects:entries}));
 const now=Date.parse('2026-11-09T00:00:00Z');

 // The default plan is the old plan: verified only, no review counts, no inferred item.
 const plain=await plan({zip:zipPath,snapshot:snapshotDir,output:path.join(scratch,'plain'),now});
 assert.equal(plain.identityPolicy,'verified_only');assert.equal(plain.inferred,0);assert.deepEqual(plain.review,{});assert.equal(plain.planned.films,1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(scratch,'plain','origin.json'),'utf8')).identityPolicy,'verified_only');
 // With the switch: the inferred film joins, the drift film is only counted for review, nothing leaks into the report.
 const out=path.join(scratch,'inferred'),report=await plan({zip:zipPath,snapshot:snapshotDir,output:out,includeInferred:true,now});
 assert.equal(report.identityPolicy,'inferred_included');assert.equal(report.inferred,1);assert.equal(report.planned.films,2);assert.deepEqual(report.review,{year_drift:1});
 assert.equal(report.matchStatus.inferred,1);assert.equal(report.matchStatus.unmatched,1);
 const text=fs.readFileSync(path.join(out,'report.json'),'utf8');for(const secret of ['Invented','Aa1','Aa3','Zz9','Drift'])assert.ok(!text.includes(secret),'report leaks '+secret);
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'origin.json'),'utf8')).identityPolicy,'inferred_included');
 const items=fs.readFileSync(path.join(out,'plan.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).item);
 const inferredItem=items.find(item=>item.lid==='Aa1'),verifiedItem=items.find(item=>item.lid==='Vv1');
 assert.deepEqual(inferredItem,{lid:'Aa1',tmdb:'101',facts:{watched:true,rating:4.5},effectiveOn:{watched:'2024-05-01'},identity:'inferred'});
 assert.ok(!('identity' in verifiedItem),'a verified item is unchanged');

 // ---- The route: validation, provenance, replay, no relabelling ----
 const sha=sha256(fs.readFileSync(zipPath)),origin={archiveSha256:sha,generatedAt:'2026-11-08T13:55:00.000Z',generatedAtSource:'archive_name'};
 const b=bucket(),env={BUCKET:b};
 for(const bad of [
  {origin,chunk:0,items:[{...inferredItem,identity:'verified'}]},
  {origin,chunk:0,items:[{...inferredItem,tmdb:null}]},
  {origin,chunk:0,items:[{...inferredItem,identity:1}]},
 ])assert.equal((await post(env,'validate',bad)).status,400,JSON.stringify(bad.items[0]).slice(0,60));
 assert.equal(F.validateBaselineRequest({origin,chunk:0,items:[verifiedItem]},{now}).items[0].identity,undefined);
 assert.equal(F.validateBaselineRequest({origin,chunk:0,items:[inferredItem]},{now}).items[0].identity,'inferred');

 const summary=await remote({mode:'commit',zip:zipPath,output:out,endpoint:'https://site.example',fetchImpl:workerFetch(env),env:{},now});
 assert.equal(summary.failed,null);
 const recordOf=lid=>[...b.records.values()].find(value=>value?.links?.letterboxd===lid);
 assert.deepEqual(recordOf('Aa1').identity,{kind:'inferred',basis:'original_title_exact_year_unique',sourceRef:sha});
 assert.equal(recordOf('Aa1').links.tmdb,'101');assert.equal(recordOf('Aa1').rating.value,4.5);
 assert.equal(recordOf('Vv1').identity,undefined,'a verified record carries no identity');
 const receipt=[...b.records.entries()].find(([key])=>key.endsWith('/chunks/0.receipt.json'))[1];
 assert.equal(receipt.entries.find(f=>f.lid==='Aa1').identity,'inferred');assert.equal(receipt.entries.find(f=>f.lid==='Vv1').identity,undefined);
 // A replay writes nothing and changes nothing.
 const putsBefore=b.puts,before=JSON.stringify(recordOf('Aa1'));
 const again=await remote({mode:'commit',zip:zipPath,output:out,endpoint:'https://site.example',fetchImpl:workerFetch(env),env:{},now});
 assert.equal(again.failed,null);assert.equal(b.puts,putsBefore);assert.equal(JSON.stringify(recordOf('Aa1')),before);

 // A record that already holds facts and a Letterboxd id is never relabelled by a later inferred item.
 const b2=bucket(),env2={BUCKET:b2},other={...origin,archiveSha256:'a'.repeat(64)},third={...origin,archiveSha256:'b'.repeat(64)};
 const asVerified={lid:'Qq1',tmdb:'101',facts:{watched:true},effectiveOn:{}};
 assert.equal((await post(env2,'commit',{origin:other,chunk:0,items:[asVerified]})).status,200);
 assert.equal((await post(env2,'commit',{origin:third,chunk:0,items:[{...asVerified,facts:{watched:true,rating:3},identity:'inferred'}]})).status,200);
 const stored=[...b2.records.values()].find(value=>value?.links?.letterboxd==='Qq1');
 assert.equal(stored.identity,undefined);assert.equal(stored.rating.value,3);

 // ---- Review blocker 1: a wrong inferred link can be corrected per film, and a rollback no longer leaves it behind ----
 const linksOf=bk=>bk.records.get('letterboxd/facts/links.json')||{};
 const factRecord=(bk,factKey)=>bk.records.get(F.recordKey(factKey));
 // The CLI corrects one film of the committed plan and leaves the rest of its chunk alone.
 const rollbackEnv={BUCKET:bucket()};
 const commitAll=await remote({mode:'commit',zip:zipPath,output:out,endpoint:'https://site.example',fetchImpl:workerFetch(rollbackEnv),env:{},now});
 assert.equal(commitAll.failed,null);
 assert.equal(linksOf(rollbackEnv.BUCKET)['letterboxd:Aa1'],'tmdb-101');assert.equal(linksOf(rollbackEnv.BUCKET)['letterboxd:Vv1']!==undefined,true);
 await assert.rejects(unlinkFilm({zip:zipPath,output:out,endpoint:'https://site.example',lid:'Vv1',fetchImpl:workerFetch(rollbackEnv),env:{},now}),/not an inferred item/);
 await assert.rejects(unlinkFilm({zip:zipPath,output:out,endpoint:'https://site.example',lid:'Nope1',fetchImpl:workerFetch(rollbackEnv),env:{},now}),/not an inferred item/);
 const one=await unlinkFilm({zip:zipPath,output:out,endpoint:'https://site.example',lid:'Aa1',fetchImpl:workerFetch(rollbackEnv),env:{},now});
 assert.equal(one.failed,null);assert.equal(one.unlinked,true);assert.equal(one.facts.restored,2);
 assert.equal(linksOf(rollbackEnv.BUCKET)['letterboxd:Aa1'],undefined,'the alias is gone');
 assert.equal(linksOf(rollbackEnv.BUCKET)['letterboxd:Vv1']!==undefined,true,'a verified link is untouched');
 const afterOne=factRecord(rollbackEnv.BUCKET,'tmdb-101');
 assert.equal(afterOne.identity,undefined);assert.equal(afterOne.links.letterboxd,null);assert.equal(afterOne.links.tmdb,'101');assert.equal(afterOne.rating,undefined,'its rating is reversed');
 assert.ok(factRecord(rollbackEnv.BUCKET,Object.values(linksOf(rollbackEnv.BUCKET))[0]),'other records stay');
 // A repeat changes nothing; the same code can now be linked to the corrected movie without an alias conflict.
 const putsBeforeRepeat=rollbackEnv.BUCKET.puts;
 const repeat=await unlinkFilm({zip:zipPath,output:out,endpoint:'https://site.example',lid:'Aa1',fetchImpl:workerFetch(rollbackEnv),env:{},now});
 assert.equal(repeat.failed,null);assert.equal(repeat.unlinked,false);
 const fixedOrigin={...origin,archiveSha256:'c'.repeat(64)};
 const fixed=await post(rollbackEnv,'commit',{origin:fixedOrigin,chunk:0,items:[{lid:'Aa1',tmdb:'202',facts:{watched:true},effectiveOn:{},identity:'inferred'}]});
 assert.equal(fixed.status,200);const fixedBody=await fixed.json();assert.equal(fixedBody.conflicts,0,'no alias conflict after the correction');
 assert.equal(linksOf(rollbackEnv.BUCKET)['letterboxd:Aa1'],'tmdb-202');
 assert.deepEqual(factRecord(rollbackEnv.BUCKET,'tmdb-202').identity,{kind:'inferred',basis:'original_title_exact_year_unique',sourceRef:'c'.repeat(64)});
 // Without the correction the same re-import is an alias conflict: counted, never written.
 const stuck={BUCKET:bucket()};
 await post(stuck,'commit',{origin,chunk:0,items:[{lid:'Aa1',tmdb:'101',facts:{watched:true},effectiveOn:{},identity:'inferred'}]});
 const blocked=await (await post(stuck,'commit',{origin:fixedOrigin,chunk:0,items:[{lid:'Aa1',tmdb:'202',facts:{watched:true},effectiveOn:{},identity:'inferred'}]})).json();
 assert.equal(blocked.conflicts,1);

 // A chunk rollback now undoes the inferred links of that chunk too and keeps a verified link.
 const whole={BUCKET:bucket()};
 assert.equal((await remote({mode:'commit',zip:zipPath,output:out,endpoint:'https://site.example',fetchImpl:workerFetch(whole),env:{},now})).failed,null);
 const rolled=await remote({mode:'rollback',zip:zipPath,output:out,endpoint:'https://site.example',fetchImpl:workerFetch(whole),env:{},now});
 assert.equal(rolled.failed,null);
 assert.equal(linksOf(whole.BUCKET)['letterboxd:Aa1'],undefined);assert.equal(linksOf(whole.BUCKET)['letterboxd:Vv1']!==undefined,true);
 assert.equal(factRecord(whole.BUCKET,'tmdb-101').identity,undefined);assert.equal(factRecord(whole.BUCKET,'tmdb-101').links.letterboxd,null);
 const replayRollback=await remote({mode:'rollback',zip:zipPath,output:out,endpoint:'https://site.example',fetchImpl:workerFetch(whole),env:{},now});
 assert.equal(replayRollback.failed,null);

 // A later observation is kept: the unlink reverses only what is still this import's, and still clears the inferred link.
 const later={BUCKET:bucket()},early={...origin,archiveSha256:'d'.repeat(64)},newer={origin:{archiveSha256:'e'.repeat(64),generatedAt:'2026-11-08T14:30:00.000Z',generatedAtSource:'archive_name'},chunk:0,items:[{lid:'Aa1',tmdb:'101',facts:{watched:true,rating:5},effectiveOn:{},identity:'inferred'}]};
 await post(later,'commit',{origin:early,chunk:0,items:[{lid:'Aa1',tmdb:'101',facts:{watched:true,rating:3},effectiveOn:{},identity:'inferred'},{lid:'Bb2',tmdb:'102',facts:{watched:true},effectiveOn:{},identity:'inferred'}]});
 assert.equal((await post(later,'commit',newer)).status,200);
 assert.equal(factRecord(later.BUCKET,'tmdb-101').rating.value,5);
 const unlink=body=>post(later,'unlink',body);
 const kept=await (await unlink({origin:early,chunk:0,lid:'Aa1'})).json();
 assert.equal(kept.unlinked,true);assert.ok(kept.facts.superseded>=1,'the newer rating is superseded, not reversed');
 assert.equal(factRecord(later.BUCKET,'tmdb-101').rating.value,5);assert.equal(factRecord(later.BUCKET,'tmdb-101').identity,undefined);
 assert.equal(linksOf(later.BUCKET)['letterboxd:Bb2'],'tmdb-102','the other film of the chunk is untouched');
 assert.equal(factRecord(later.BUCKET,'tmdb-102').identity.kind,'inferred');
 // Refusals: a film that is not an inferred entry of that chunk, and a chunk with no receipt.
 assert.equal((await unlink({origin:early,chunk:0,lid:'Zz1'})).status,409);
 assert.equal((await unlink({origin:early,chunk:7,lid:'Aa1'})).status,409);
 assert.equal((await unlink({origin:early,chunk:0,lid:'bad lid!'})).status,400);
 assert.equal((await post(later,'unlink',{origin:early,chunk:0})).status,400);
}finally{await rm(scratch,{recursive:true,force:true});}
console.log('Letterboxd inferred identity: off by default and accepted rows unchanged, unique original title with the same year, every review bucket (year drift, alias only, linked elsewhere, duplicate in export, already accepted, no TMDB id, missing year), remakes told apart by year, plan switch and counts without names, route validation, provenance, replay and no relabelling');
