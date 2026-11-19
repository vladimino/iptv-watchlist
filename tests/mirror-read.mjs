// AIR-541 (ADR 0177): the degraded, read-only view of the R2 mirrors. Every object is validated ALONE; an invalid one never disqualifies another; the programme/watchlist
// join is a best-effort heuristic; the film identity is proven only by a resolved TMDB movie link. Local stand-ins only; the bucket records every write and there must be none.
import assert from 'node:assert/strict';
import * as M from '../src/mirror-read.js';
import {MemoryBucket} from './memory-bucket.mjs';

class Bucket extends MemoryBucket{
 constructor(){super();this.writes=[];this.gets=[];this.hooks=new Map();}
 async put(...args){this.writes.push('put');return super.put(...args);}
 async delete(...args){this.writes.push('delete');return super.delete(...args);}
 async get(key){this.gets.push(key);const hook=this.hooks.get(key);if(hook){this.hooks.delete(key);await hook();}return super.get(key);}
}
const A='aaaaaaaa-0000-4000-8000-000000000001',B='bbbbbbbb-0000-4000-8000-000000000002',C='cccccccc-0000-4000-8000-000000000003';
const link=id=>({status:'resolved',link:{type:'movie',id:Number(id)}});
const film=(id,tmdb,title='Film '+id,year=2020)=>({id,tmdbId:String(tmdb),title,year,tmdbLink:link(tmdb),shows:[]});
const programme=(runId,films,extra={})=>({runId,updatedAt:'2026-11-19T10:00:00.000Z',watchlistCount:films.length,films,...extra});
const watchlist=(films,updatedAt='2026-11-19T10:00:00.000Z')=>({updatedAt,films});
const put=(bucket,key,value,raw=false)=>bucket.objects.set(key,{text:raw?value:JSON.stringify(value),customMetadata:{}});
const gen=(run,name)=>'epg/generations/'+run+'/'+name;
const make=({pointer=A,root=null,rootWatch=null,copies={}}={})=>{
 const bucket=new Bucket();
 if(pointer)put(bucket,'epg/published-generation.json',{programmeRunId:pointer,phase:'published'});
 if(root)put(bucket,'programme.json',root);
 if(rootWatch)put(bucket,'watchlist.json',rootWatch);
 for(const [run,parts] of Object.entries(copies)){if(parts.programme)put(bucket,gen(run,'programme.json'),parts.programme);if(parts.watchlist)put(bucket,gen(run,'watchlist.json'),parts.watchlist);}
 return bucket;
};
const read=bucket=>M.readMirrorSnapshot({BUCKET:bucket});
const f1=film('tmdb_42',42);

// 1. The pointer's generation copy wins; the pair is joined by the run key (best effort).
{
 const bucket=make({copies:{[A]:{programme:programme(A,[f1]),watchlist:watchlist([f1])}},root:programme(B,[film('tmdb_9',9)]),rootWatch:watchlist([film('tmdb_9',9)])});
 const s=await read(bucket);
 assert.equal(s.programme.runId,A);assert.equal(s.programme.source,'generation_copy');
 assert.equal(s.watchlist.source,'generation_copy');assert.equal(s.joined,'best_effort');assert.equal(s.joinBasis,'same_run_key');
 assert.deepEqual(bucket.writes,[],'a degraded read never writes');
}
// 2. Pointer lagging the root: a valid root programme is used by its OWN schema and runId, never discarded; no join is claimed with a root watchlist of another time.
{
 const bucket=make({pointer:A,root:programme(B,[f1]),rootWatch:watchlist([f1])});
 const s=await read(bucket);
 assert.equal(s.programme.runId,B,'the root programme stays a valid standalone source');assert.equal(s.programme.source,'root');
 assert.equal(s.watchlist.source,'root');assert.equal(s.joined,'none');assert.equal(s.joinBasis,'unproven_root');
}
// 3. Root pair behind a pointer that agrees: best-effort join by the pointer.
{
 const s=await read(make({pointer:A,root:programme(A,[f1]),rootWatch:watchlist([f1])}));
 assert.equal(s.joined,'best_effort');assert.equal(s.joinBasis,'pointer_root');
}
// 4. Only a programme / only a watchlist: partial rendering input, never an all-or-nothing refusal.
{
 const onlyProgramme=await read(make({root:programme(A,[f1])}));
 assert.ok(onlyProgramme.programme&&!onlyProgramme.watchlist);assert.equal(onlyProgramme.joined,'none');
 const onlyWatchlist=await read(make({pointer:null,rootWatch:watchlist([f1])}));
 assert.ok(!onlyWatchlist.programme&&onlyWatchlist.watchlist);assert.equal(onlyWatchlist.watchlist.source,'root');
 const nothing=await read(make({pointer:null}));
 assert.ok(!nothing.programme&&!nothing.watchlist);
}
// 5. Older run only: no pointer, no root, only an older generation copy (found by listing the prefix); the newest valid copy wins.
{
 const bucket=make({pointer:null,copies:{[B]:{programme:programme(B,[f1],{updatedAt:'2026-11-18T09:00:00.000Z'}),watchlist:watchlist([f1],'2026-11-18T09:00:00.000Z')},[C]:{programme:programme(C,[f1],{updatedAt:'2026-11-17T09:00:00.000Z'})}}});
 const s=await read(bucket);
 assert.equal(s.programme.runId,B,'the newest snapshot of the older copies');assert.equal(s.programme.source,'older_generation_copy');
 assert.equal(s.watchlist.source,'generation_copy');assert.equal(s.joined,'best_effort');
 assert.deepEqual(bucket.writes,[]);
}
// 6. One corrupted object does not disqualify the others (truncated JSON, wrong shape, run id of another run, too large).
{
 const bucket=make({root:programme(A,[f1]),rootWatch:watchlist([f1])});
 put(bucket,gen(A,'programme.json'),'{"runId":"'+A+'","films":[',true);
 let s=await read(bucket);
 assert.equal(s.programme.source,'root','a truncated generation copy falls to the valid root');assert.ok(s.rejected.some(item=>item.reason==='invalid_json'));
 put(bucket,gen(A,'programme.json'),{runId:B,films:[f1]});
 s=await read(bucket);assert.ok(s.rejected.some(item=>item.reason==='run_mismatch'),'a copy whose runId is not its key is dropped');assert.equal(s.programme.source,'root');
 put(bucket,gen(A,'watchlist.json'),{updatedAt:'x',films:'nope'});
 s=await read(bucket);assert.equal(s.watchlist.source,'root','an invalid watchlist copy falls to the root watchlist');assert.ok(s.programme,'the programme is unaffected');
 const big=make({root:programme(A,[f1]),rootWatch:watchlist([f1])});
 const original=big.get.bind(big);big.get=async key=>{const object=await original(key);return key==='watchlist.json'&&object?{...object,size:M.MIRROR_MAX_BYTES+1}:object;};
 s=await read(big);assert.ok(!s.watchlist&&s.programme,'an oversized object is dropped alone');assert.ok(s.rejected.some(item=>item.reason==='too_large'));
}
// 7. Same-run overwrite / ABA while reading: each part keeps its OWN snapshot time; the overall asOf is the oldest, so no part claims to be fresher than it is.
{
 const bucket=make({copies:{[A]:{programme:programme(A,[f1],{updatedAt:'2026-11-19T10:00:00.000Z'}),watchlist:watchlist([f1],'2026-11-19T09:00:00.000Z')}}});
 bucket.hooks.set(gen(A,'watchlist.json'),async()=>put(bucket,gen(A,'watchlist.json'),watchlist([f1],'2026-11-19T11:30:00.000Z')));
 const s=await read(bucket);
 assert.equal(s.watchlist.asOf,'2026-11-19T11:30:00.000Z');assert.equal(s.programme.asOf,'2026-11-19T10:00:00.000Z');
 const meta=M.mirrorMeta(s,'x');
 assert.equal(meta.asOf,'2026-11-19T10:00:00.000Z','the overall asOf is the oldest part');
 assert.deepEqual(meta.parts.map(part=>part.object),['programme','watchlist']);assert.equal(meta.joined,'best_effort');assert.equal(meta.readOnly,true);assert.equal(meta.source,'mirror');
}
// 8. A storage failure on one key is only that key.
{
 const bucket=make({root:programme(A,[f1]),rootWatch:watchlist([f1])});
 const original=bucket.get.bind(bucket);bucket.get=async key=>{if(key==='watchlist.json')throw new Error('R2 down');return original(key);};
 const s=await read(bucket);assert.ok(s.programme&&!s.watchlist);
 assert.equal((await M.readMirrorSnapshot({})).programme,null,'no bucket is an empty snapshot, not an exception');
}

// ---- film identity (C1) ----
{
 const s=await read(make({copies:{[A]:{programme:programme(A,[f1]),watchlist:watchlist([f1])}}}));
 const found=M.mirrorFilmIdentity(s,'42');
 assert.equal(found.state,'found');assert.equal(found.film.canonicalIdentity,'tmdb:42');assert.equal(found.film.tmdbId,'42');assert.equal(found.film.title,'Film tmdb_42');
 assert.equal(found.disputed,false);assert.equal(found.provenance.runId,A);
 assert.equal(M.mirrorFilmIdentity(s,'43').state,'unproven');assert.equal(M.mirrorFilmIdentity(s,'43').reason,'not_in_mirror');
 for(const bad of ['0','-1','abc','1.5',''])assert.equal(M.mirrorFilmIdentity(s,bad).reason,'invalid_id');
 assert.equal(M.mirrorFilmIdentity(s,'42').state==='found'&&true,true);
}
// The same verified TMDB id with different title/year in two valid copies is one identity: a deterministic candidate (the pointer's programme) is shown with its provenance.
{
 const s=await read(make({copies:{[A]:{programme:programme(A,[film('tmdb_42',42,'Нов. название',2021)]),watchlist:watchlist([film('tmdb_42',42,'Old name',2020)])}}}));
 const found=M.mirrorFilmIdentity(s,'42');
 assert.equal(found.state,'found');assert.equal(found.film.title,'Нов. название','the programme of the pointer run is preferred');assert.equal(found.disputed,true);assert.equal(found.sources.length,2);
 const again=M.mirrorFilmIdentity(s,'42');assert.deepEqual(again,found,'the choice is deterministic');
}
// A film only in an older run's copy is still identified (provenance names that run).
{
 const s=await read(make({pointer:null,copies:{[B]:{programme:programme(B,[film('tmdb_7',7)])}}}));
 const found=M.mirrorFilmIdentity(s,'7');assert.equal(found.state,'found');assert.equal(found.provenance.runId,B);
}
// A catalogFilms entry proves identity too.
{
 const s=await read(make({root:programme(A,[],{catalogFilms:[film('tmdb_8',8)]})}));
 assert.equal(M.mirrorFilmIdentity(s,'8').state,'found');
}
// A contradictory identity KEY is unproven, never a 409: two ids claiming one TMDB id, or an entry whose own link disagrees with its id.
{
 const two=await read(make({root:programme(A,[film('w1',5),film('w2',5)])}));
 assert.equal(M.mirrorFilmIdentity(two,'5').reason,'identity_key_contradiction');
 const mislinked=await read(make({root:programme(A,[{...film('tmdb_9',9),tmdbLink:link(10)}])}));
 assert.equal(M.mirrorFilmIdentity(mislinked,'9').reason,'identity_key_contradiction');
 const unresolved=await read(make({root:programme(A,[{id:'tmdb_11',tmdbId:'11',title:'X',tmdbLink:{status:'candidate'}}])}));
 assert.equal(M.mirrorFilmIdentity(unresolved,'11').state,'unproven','an unresolved link is no proof');
}
// The module itself cannot write: no PUT, delete or SQL in its source.
import fs from 'node:fs';
const source=fs.readFileSync('src/mirror-read.js','utf8').replace(/\/\/.*$/gm,'');
assert.ok(!/\.(put|delete|prepare|batch)\(/.test(source),'mirror-read.js has no write call');
console.log('mirror read: per-object validation, pointer/root skew, older-run only, corrupt objects, ABA, best-effort join, TMDB identity and contradictions passed');
