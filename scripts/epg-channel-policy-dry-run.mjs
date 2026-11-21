// Offline dry run of the EPG Channel policy over a LOCAL XMLTV file. It reads two local files, writes nothing and opens no network, database or bucket.
//   node scripts/epg-channel-policy-dry-run.mjs --xmltv feed.xml --policies policies.json [--watchlist watchlist.json] [--now 2026-11-21T12:00:00Z]
// policies.json: [["ch001",{"policy":"discover","basis":"category"}], ...] (the entries of the Map that materializePolicies returns; ids the file lacks are `known_only`).
// watchlist.json: the films array scanEPG takes (optional, default none). The report compares the scan without and with the policy: raw counters, post-filter counters,
// the kept and dropped show keys (channel|start) by Film and candidate, and the channels the feed has that the policy map does not hold. No title or key is printed beyond counts
// unless --keys is given; keep the output out of GitHub and logs when a real feed is used.
import fs from 'node:fs';
import vm from 'node:vm';
import {Readable} from 'node:stream';

const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,all)=>value.startsWith('--')?[...pairs,[value.slice(2),all[index+1]&&!all[index+1].startsWith('--')?all[index+1]:true]]:pairs,[]));
if(!args.xmltv||!args.policies){console.error('usage: --xmltv <file> --policies <json> [--watchlist <json>] [--now <iso>] [--keys]');process.exit(2);}
const now=args.now?Date.parse(args.now):Date.now();
const policies=new Map(JSON.parse(fs.readFileSync(args.policies,'utf8')));
const watchlist=args.watchlist?JSON.parse(fs.readFileSync(args.watchlist,'utf8')):[];
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch:()=>{throw new Error('no network in a dry run');},console});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;',context);
const run=async options=>{context.stream=Readable.toWeb(fs.createReadStream(args.xmltv));context.watchlist=structuredClone(watchlist);context.now=now;context.options=options;return vm.runInContext('scanEPG(stream,watchlist,now,options)',context);};
const keysOf=result=>new Set([...result.films.flatMap(f=>f.shows.map(s=>'film:'+f.id+'|'+s.channelId+'|'+s.start)),...result.discovery.flatMap(d=>d.shows.map(s=>'cand:'+d.key+'|'+s.channelId+'|'+s.start))]);
const before=await run({policies:null}),after=await run({policies});
const a=keysOf(before),b=keysOf(after);
const lost=[...a].filter(key=>!b.has(key)),gained=[...b].filter(key=>!a.has(key));
const report={
 raw:{scanned:before.stats.scanned,channelsInFeed:after.stats.policy.channels.total},
 withoutPolicy:{retained:before.stats.retained,films:before.films.length,candidates:before.discovery.length,filmShows:before.films.reduce((n,f)=>n+f.shows.length,0)},
 withPolicy:{retained:after.stats.retained,films:after.films.length,candidates:after.discovery.length,filmShows:after.films.reduce((n,f)=>n+f.shows.length,0),policy:after.stats.policy},
 newChannels:after.newChannels.length,
 keys:{before:a.size,after:b.size,lost:lost.length,gainedUnexpected:gained.length},
 lostFilmShowsOnAllowedChannels:lost.filter(key=>key.startsWith('film:')).filter(key=>{const channel=key.split('|')[1];const p=policies.get(channel);return p&&p.policy!=='deny_all';}).length,
};
console.log(JSON.stringify(report,null,1));
if(args.keys)console.log(JSON.stringify({lost,gained},null,1));
if(report.keys.gainedUnexpected>0)process.exitCode=1;
