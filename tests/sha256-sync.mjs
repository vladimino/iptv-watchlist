// AIR-648: the Worker-compatible synchronous SHA-256 (src/sha256-sync.js) must equal node:crypto createHash('sha256') byte for byte,
// for every input shape the shared Film resolver/aggregate hashes: JSON bodies (identity/section tokens), raw ratings text (etag), UTF-8.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {sha256Hex,sha256HexOfBytes} from '../src/sha256-sync.js';

const node=input=>crypto.createHash('sha256').update(input).digest('hex');

// Known vectors.
assert.equal(sha256Hex(''),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
assert.equal(sha256Hex('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');

// Every length around the 55/56/63/64/119/120 padding boundaries, plus bulk.
for(let n=0;n<=300;n++){
 const bytes=Uint8Array.from({length:n},(_,i)=>(i*31+n)&255);
 assert.equal(sha256HexOfBytes(bytes),node(bytes),'bytes length '+n);
}
const big=Uint8Array.from({length:1_000_003},(_,i)=>(i*7+i%13)&255);
assert.equal(sha256HexOfBytes(big),node(big),'1 MB');

// UTF-8: multi-byte, astral, combining, lone surrogates (both hash U+FFFD), NUL.
for(const text of ['é','Amélie','Ёлки-палки','日本語タイトル','🎬🍿','é','\ud800','a\udc00b','\u0000x','\r\n\t "quote" \\ back']){
 assert.equal(sha256Hex(text),node(text),JSON.stringify(text));
}

// The real digest shapes: 'sha256:'+hex of JSON.stringify(body), and a raw ratings document etag over joined parts.
const body={marker:{generation:3},films:[{id:'film_ä',present:true,redirects:[],revisions:[],claims:0,decisions:0}],owned:[],claimed:[],decisions:[]};
assert.equal('sha256:'+sha256Hex(JSON.stringify(body)),'sha256:'+node(JSON.stringify(body)));
const ratings=JSON.stringify({items:Array.from({length:500},(_,i)=>({lid:'l'+i,title:'Título '+i,rating:i%11/2}))});
assert.equal(sha256Hex(ratings),node(ratings));

// Hard-guard against re-introducing the Node-only import into the shared Worker-bound modules.
for(const file of ['src/film-aggregate.js','src/film-aggregate-resolver.js','src/film-history-aggregate.js']){
 assert.ok(!/node:crypto|createHash/.test(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8')),file+' must stay Worker-compatible');
}
console.log('sha256-sync ok');
