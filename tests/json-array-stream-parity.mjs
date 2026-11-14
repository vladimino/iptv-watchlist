// AIR-460: forEachJsonArrayItems must return exactly what JSON.parse gives for every way a stream can be cut into chunks, and must
// keep failing closed on a truncated or malformed document. Its source is read from src/sources.js (the function is not exported).
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../src/sources.js',import.meta.url),'utf8');
const start=source.indexOf('async function forEachJsonArrayItems'),end=source.indexOf('function groupDiscoveryRaws');
assert.ok(start>0&&end>start,'forEachJsonArrayItems found');
const forEachJsonArrayItems=new Function(source.slice(start,end)+'\nreturn forEachJsonArrayItems;')();

async function* cut(text,size){for(let i=0;i<text.length;i+=size)yield text.slice(i,i+size);}
async function run(text,size,field='items'){const items=[];const wrapper=await forEachJsonArrayItems(cut(text,size),field,item=>{items.push(item);});return {items,wrapper};}

const document={programmeRunId:'run-1',items:[
 {key:'a',title:'caf\u00e9 \u2603 \ud83c\udfac',note:'quote " backslash \\ brace } bracket ] comma ,',nested:{list:[1,2,{x:'y'}],empty:{}}},
 {key:'b',title:'\\u00e9 escaped',n:-1.5e3,t:true,f:false,z:null},
 [],'text',7,
],tail:{count:5,flags:['x']}};
const text=JSON.stringify(document);
for(const size of [1,2,3,5,7,16,64,1000,text.length]){
 const {items,wrapper}=await run(text,size);
 assert.deepEqual(items,document.items,'items, chunk size '+size);
 assert.deepEqual(wrapper,{programmeRunId:'run-1',tail:document.tail},'wrapper, chunk size '+size);
}
const spaced=JSON.stringify(document,null,2)+'\n  ';
for(const size of [1,4,33])assert.deepEqual((await run(spaced,size)).items,document.items,'whitespace, chunk size '+size);

const big=[];for(let i=0;i<5000;i++)big.push({key:'k'+i,title:'t\u00e9'+i,pad:'x'.repeat(40)});
const bigText=JSON.stringify({items:big});
assert.deepEqual((await run(bigText,65536)).items,big,'large document in 64 KiB chunks');

const bad=[
 ['truncated in an item',text.slice(0,60)],
 ['truncated after the items',text.slice(0,text.indexOf('"tail"'))],
 ['no items field','{"other":[1]}'],
 ['items is not an array','{"items":{}}'],
 ['second items field','{"items":[],"items":[]}'],
 ['trailing garbage',text+'x'],
];
for(const [name,value] of bad)for(const size of [1,9])await assert.rejects(()=>run(value,size),/Discovery ledger JSON is incomplete/,name+', chunk size '+size);
console.log('json array stream parity ok');
