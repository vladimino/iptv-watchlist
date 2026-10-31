import fs from 'node:fs';
import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPage,diaryRow,migrated,QUEUE,CURSOR,RUN,SEPARATE,H,eventKeyOf,plain,g} from './ratings-harness.mjs';

// ADR 0060 decisions 2, 3 and 10 at the EPG commit, with the Diary read of ADR 0064. Under `inline` (and `separate`
// before the migration) the routine sync writes the current page-1 Diary reader. The golden snapshot is this code
// (`node tests/ratings-epg.mjs --golden .`). It is not a byte copy of the multi-page reader. Under active `separate`
// the commit only enqueues removal references, durably and before it publishes, and requests nothing from Letterboxd
// for ratings.
const GOLDEN='tests/fixtures/ratings-inline-parity.json';
const T0=Date.parse('2026-10-31T08:00:00.000Z');
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
const WATCHLIST='<span class="js-watchlist-count">1</span><div data-component-class="LazyPoster" data-item-name="Heat (1995)" data-item-link="/film/heat-1995/" data-postered-identifier="{&quot;lid&quot;:&quot;film1&quot;}"></div>';
const FILM='<meta name="description" content="A crew plans a robbery."><span data-tmdb-id="1656"></span><script type="application/ld+json">{"name":"Heat","genre":"Crime","duration":"PT2H50M","director":{"name":"Michael Mann","sameAs":"https://letterboxd.com/director/michael-mann/"},"actor":[{"name":"Al Pacino","sameAs":"https://letterboxd.com/actor/al-pacino/"}]}</script>';
const xmltv=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const EPG=()=>`<tv><channel id="c1"><display-name>Кино</display-name></channel><programme channel="c1" start="${xmltv(T0+10*H)}" stop="${xmltv(T0+10*H+170*60000)}"><title>Heat (1995)</title></programme></tv>`;
// The saved watchlist before the sync: Heat stays, two films leave. The Diary proves one of them; the other is looked up.
const BEFORE={updatedAt:'2026-10-30T08:00:00.000Z',films:[{id:'film1',title:'Heat',year:1995,url:'https://letterboxd.com/film/heat-1995/'},{id:'film2',title:'Gone',year:2000,url:'https://letterboxd.com/film/gone-film/'},{id:'film3',title:'Other',year:2001,url:'https://letterboxd.com/film/other-film/'}]};

async function lifecycle({root='.',extra={},prepare=null}={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 net.watchlist=WATCHLIST;net.films.set('https://letterboxd.com/film/heat-1995/',FILM);net.epg=EPG;
 net.diary.set(1,diaryPage([diaryRow('film2',8,'2026-10-29','701'),diaryRow('film1',9,'2026-10-20','702')],false));
 net.members.set('other-film',3.5);
 bucket.set('watchlist.json',BEFORE);
 const ctx=loadContext({net,clock,FakeDate,crypto,root});
 const env=baseEnv(bucket,{LETTERBOXD_DIARY_HISTORY:'on',REMOVAL_RATING_LOOKUP:'on',...extra});
 if(prepare)await prepare({bucket,env,ctx,net,clock});
 const execution={waitUntil(){},exports:{DiscoveryContinuation:{async fetch(){return Response.json({ok:true});}}}};
 const post=async(path,body)=>{const response=await ctx.worker.fetch(new Request('https://iptv.example'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,execution);return {status:response.status,body:await response.json()};};
 const replies=[];
 const start=await post('/api/sync/start',{});replies.push(start);
 const runId=start.body.runId;
 for(let i=0;i<4;i++){const step=await post(start.body.stage==='metadata'&&i===0?'/api/sync/metadata':'/api/sync/epg',{runId});replies.push(step);if(step.body.stage==='complete'&&i>0)break;}
 return {bucket,net,ctx,env,replies,snapshot:bucket.snapshot(),post,runId};
}

if(process.argv[2]==='--golden'){
 const {snapshot,replies,net}=await lifecycle({root:process.argv[3]});
 fs.mkdirSync('tests/fixtures',{recursive:true});
 fs.writeFileSync(GOLDEN,JSON.stringify({about:'Inline EPG sync with the Diary recent window (ADR 0064): one Diary page, R2 objects after the run, step replies and requests. Synthetic fixture data only. Not a byte copy of the multi-page reader.',snapshot,replies,fetches:net.fetches},null,1)+'\n');
 console.log('golden written');process.exit(0);
}
const golden=JSON.parse(fs.readFileSync(GOLDEN,'utf8'));

// 1. Inline parity: the default, an explicit `inline`, a malformed value, and `separate` before the migration.
for(const extra of [{},{RATINGS_PIPELINE:'inline'},{RATINGS_PIPELINE:'Separate'},{RATINGS_PIPELINE:'separate'}]){
 const {snapshot,replies,net}=await lifecycle({extra});
 const label=JSON.stringify(extra);
 eq(Object.keys(snapshot),Object.keys(golden.snapshot),label+': the same objects');
 for(const key of Object.keys(golden.snapshot))assert.equal(JSON.stringify(snapshot[key]),JSON.stringify(golden.snapshot[key]),label+': '+key+' byte for byte');
 eq(replies,golden.replies,label+': the same replies');
 eq(net.fetches,golden.fetches,label+': the same requests');
}
assert.ok(golden.snapshot[QUEUE]&&golden.snapshot[CURSOR],'the golden run exercised the queue and the Diary cursor');
assert.equal(golden.snapshot[QUEUE].schemaVersion,1);
assert.equal(golden.fetches.filter(url=>url.includes('/diary/')).length,1,'the inline commit fetches Diary page 1 only');
assert.equal(golden.snapshot[CURSOR].lastOutcome,'recent_window');
assert.equal(golden.snapshot[CURSOR].coverage.window,'recent');
assert.equal(golden.snapshot[CURSOR].coverage.reachedEnd,false);

// 2. Active `separate`: the commit enqueues one reference per removed film to the run's removal event, before it
// publishes, requests nothing for ratings, leaves no ratings marker and no hand-over in sync.json.
{
 const order=[];
 const {bucket,net,replies,runId}=await lifecycle({extra:SEPARATE,prepare:({bucket})=>{migrated(bucket);const put=bucket.put.bind(bucket);bucket.put=async(key,...rest)=>{if(key===QUEUE||key==='epg/published-generation.json')order.push(key);return put(key,...rest);};}});
 assert.equal(replies.at(-1).body.stage,'complete');assert.equal(replies.at(-1).body.ratingsPipeline,'separate');
 eq([net.diaryFetches(),net.memberFetches()],[[],[]],'no Diary page, no member page');
 eq(order.slice(0,2),[QUEUE,'epg/published-generation.json'],'the references are durable before the publish');
 const sync=bucket.value('sync.json');
 eq([sync.ratingPending,sync.removalRefs,sync.removalLookups,sync.ratingAttempt,sync.ratingsPipeline],[undefined,undefined,undefined,undefined,'separate']);
 const event=sync.events.find(item=>item.type==='watchlist'),key=eventKeyOf(event.at,event.id);
 const queue=bucket.value(QUEUE);
 eq(Object.keys(queue.films).sort(),['film2','film3']);
 for(const id of ['film2','film3'])eq(queue.films[id].refs,[{eventKey:key,sourceRunId:runId,at:event.at,resolved:false}],id);
 assert.ok(bucket.value(key),'the removal event is written by the commit');
 assert.equal(bucket.value(CURSOR).lastAttemptAt,undefined,'the cursor is untouched');
 assert.ok(!bucket.records.has('letterboxd/diary/history.json'),'no Diary history');
 assert.ok(![...bucket.records.keys()].some(item=>item.startsWith('letterboxd/facts/records/')&&JSON.stringify(bucket.value(item)).includes('letterboxd_diary')),'no Diary facts');
}

// 3. A kill after the enqueue and before sync.json drops the hand-over: the retry enqueues again, idempotently; a sync
// start flushes a hand-over left in a completed sync.json before it replaces it.
{
 let killed=false;
 const {bucket,replies,post,runId}=await lifecycle({extra:SEPARATE,prepare:({bucket})=>{migrated(bucket);bucket.hooks.beforePut=(key,value)=>{if(key==='sync.json'&&!killed&&value.stage==='epg'&&value.events&&!value.removalRefs&&bucket.value('sync.json')?.removalRefs){killed=true;throw new Error('isolate killed');}};}});
 assert.ok(killed);
 assert.equal(replies.at(-1).body.stage,'complete');
 eq(bucket.value(QUEUE).films.film2.refs.length,1,'one reference despite the replay');
 bucket.hooks.beforePut=null;
 const sync=bucket.value('sync.json');
 bucket.set('sync.json',{...sync,removalRefs:{ref:{eventKey:eventKeyOf('2026-10-31T09:00:00.000Z','x-watchlist'),sourceRunId:'x',at:'2026-10-31T09:00:00.000Z'},films:[{id:'film9',url:'https://letterboxd.com/film/ninth/'}]}});
 const next=await post('/api/sync/start',{});
 assert.ok(next.body.runId&&next.body.runId!==runId);
 eq(bucket.value(QUEUE).films.film9.refs[0].sourceRunId,'x','flushed before sync.json was replaced');
 assert.equal(bucket.value('sync.json').ratingPending,undefined,'a separate run carries no ratings marker');
}

// 4. Ratings never block the EPG commit: a live ratings run holding its lease, and a Letterboxd that fails every Diary
// and member request, change nothing about the commit.
{
 const {replies,net,bucket}=await lifecycle({extra:SEPARATE,prepare:({bucket,net})=>{migrated(bucket);bucket.set(RUN,{schemaVersion:1,runId:'live',state:'running',phase:'diary',lease:{step:'s',expiresAt:new Date(T0+60000).toISOString()},startedAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString(),checkpoint:{},recent:[]});net.hang=url=>url.includes('/diary/')||url.includes('/demo-user/film/');}});
 assert.equal(replies.at(-1).body.stage,'complete');
 eq([net.diaryFetches(),net.memberFetches()],[[],[]]);
 assert.equal(bucket.value(RUN).lease.step,'s','the EPG commit does not touch the ratings run');
}

// 5. The footer follows the ratings run under active `separate`.
{
 const {ctx,env,bucket}=await lifecycle({extra:SEPARATE,prepare:({bucket})=>migrated(bucket)});
 const R=g(ctx,'LetterboxdRatings');
 let footer=plain(await ctx.footerStatus(env)).integrations.sources.find(item=>item.id==='letterboxd_ratings');
 eq([footer.state,footer.code,footer.pipeline],['unknown','no_data','separate']);
 const {runId}=plain(await R.start(env,{trigger:'manual'}));
 footer=plain(await ctx.footerStatus(env)).integrations.sources.find(item=>item.id==='letterboxd_ratings');
 eq([footer.state,footer.code],['running','running']);
 for(let i=0;i<5&&bucket.value(RUN).state==='running';i++)await R.step(env,{runId});
 footer=plain(await ctx.footerStatus(env)).integrations.sources.find(item=>item.id==='letterboxd_ratings');
 eq([footer.state,footer.code],['healthy','ok']);
}

console.log('Ratings at the EPG commit (ADR 0060, ADR 0064): inline, explicit inline, malformed and unmigrated separate reproduce the page-1 golden byte for byte; active separate enqueues references before the publish without Diary or member requests, survives a kill between the enqueue and sync.json, flushes a left hand-over at the next start, is not blocked by a live ratings run or a failing Letterboxd, and the footer follows the ratings run passed');
