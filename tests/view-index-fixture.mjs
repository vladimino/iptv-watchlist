// AIR-558: the Worker derives the view index from D1 only (ADR 0183); there is no raw `enrichment/view-index.json` reader any more. Most test files are about something
// else (the footer, Finds, the queue, Admin pages, the prediction runner) and keep a plain view-index fixture in their fake R2 bucket. Those files call
// `installViewIndexFixture(context)` AFTER the Worker sources are loaded: it replaces the three D1-derived readers with a read of that fixture object, so the fixture
// IS the derived view index. This is a test-only seam. The real D1 derivation (key union, overlay rules, refusals, version token) is tested on a sqlite D1 stand-in in
// tests/view-index-d1-source.mjs and must not be tested through this seam. The seam never writes.
import vm from 'node:vm';

export const VIEW_INDEX_FIXTURE_KEY='enrichment/view-index.json';
const SOURCE=`{
 const key='enrichment/view-index.json';
 const read=async env=>{const object=await env.BUCKET.get(key);if(!object)return {};return typeof object.json==='function'?object.json():JSON.parse(await object.text());};
 derivedViewIndex=async function(env,options){return read(env);};
 viewIndexD1Version=async function(env){const object=await env.BUCKET.get(key);return 'fixture:'+(object?.etag??'none');};
 if(typeof footerViewIndex==='function')footerViewIndex=async function(env){const index=await read(env);return footerIndexProjection(Object.fromEntries(Object.entries(index).map(([id,item])=>[id,footerPick(item,FOOTER_INDEX_FIELDS)])));};
}`;
export function installViewIndexFixture(context){vm.runInContext(SOURCE,context);return context;}
