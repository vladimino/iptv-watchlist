// AIR-579: one structured log line per whole-catalog read (`readCatalog`): row count, elapsed time, projection flag and nothing else, so an aggregate by invocation attributes the reads
// of a window to their callers. Real Discovery authority over a D1 stand-in at the real schema; nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const CANARY='CANARY-TITLE-9921';
const world=await flowWorld({films:30,extra:n=>({synopsis:CANARY+' '+n})});
const realLog=console.log,lines=[];
const capture=()=>{lines.length=0;console.log=(...parts)=>{lines.push(parts.join(' '));};};
const restore=()=>{console.log=realLog;};
const catalogLines=()=>lines.filter(line=>line.startsWith('{"event":"discovery_catalog_read"')).map(line=>JSON.parse(line));
const KEY='epg/discovered-films.json';

try{
 // A whole-catalog read through the router: one line, exactly these keys, the true row count, no content.
 capture();
 const routed=await Authority.routeRead(world.env,KEY);
 assert.equal(routed.handled,true);assert.equal(Object.keys(routed.value).length,30);
 assert.equal(catalogLines().length,1,'one line per whole-catalog read');
 assert.deepEqual(Object.keys(catalogLines()[0]).sort(),['event','ms','projected','rows']);
 assert.equal(catalogLines()[0].rows,30);assert.equal(catalogLines()[0].projected,false);
 assert.ok(Number.isInteger(catalogLines()[0].ms)&&catalogLines()[0].ms>=0);
 assert.ok(lines.every(line=>!line.includes(CANARY)&&!line.includes('tmdb_1')),'no film content, id or title in the log');

 // A projected read says so, still one line, still no content.
 capture();
 await Authority.routeRead(world.env,KEY,{project:film=>({id:film.id})});
 assert.equal(catalogLines().length,1);assert.equal(catalogLines()[0].projected,true);assert.ok(lines.every(line=>!line.includes(CANARY)));

 // Two reads, two lines: the count is what an aggregate sums.
 capture();
 await Authority.routeRead(world.env,KEY);await Authority.routeRead(world.env,KEY);
 assert.equal(catalogLines().length,2);

 // Reads that are not a whole-catalog read write no such line: a by-id read and the per-tmdb read.
 capture();
 await Authority.readAdmissionsById(world.env,['tmdb_1','tmdb_2']);
 await Authority.readFilmAdmission(world.env,'1');
 assert.equal(catalogLines().length,0,'the bounded reads are not whole-catalog reads');

 // A read that fails (an unreadable catalog) writes no line and the error is the read's own.
 capture();
 const failing={...world.env,DB:{prepare:()=>({bind:()=>({all:async()=>{throw new Error('D1_ERROR: unavailable');},first:async()=>{throw new Error('D1_ERROR: unavailable');},run:async()=>{throw new Error('D1_ERROR: unavailable');}}),all:async()=>{throw new Error('x');},first:async()=>{throw new Error('x');}}),batch:async()=>{throw new Error('x');}}};
 await assert.rejects(()=>Authority.routeRead(failing,KEY));
 assert.equal(catalogLines().length,0);

 // The log changes no result: with a console that throws, the read answers the same.
 const before=await Authority.routeRead(world.env,KEY);
 console.log=()=>{throw new Error('log sink down');};
 const after=await Authority.routeRead(world.env,KEY);
 assert.deepEqual(JSON.parse(JSON.stringify(after)),JSON.parse(JSON.stringify(before)));
}finally{restore();}
console.log('discovery catalog read log: one line per whole-catalog read, count and time only, no content, a failing sink changes no result');
