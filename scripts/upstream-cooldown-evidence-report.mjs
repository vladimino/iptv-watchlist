#!/usr/bin/env node
// Offline aggregator of the UC2 observe evidence (AIR-609; ADR 0211 decision 5). Reads Worker log text (one or more files, or stdin) that was exported by a SEPARATE authorized read
// of the Worker `iptv` logs, and prints the per caller x scope x decision accounting. It makes no network call, reads no database and writes nothing but its own stdout.
//
// WHAT THE NUMBERS ARE. The Worker writes one JSON line `{"event":"upstream_cooldown","decision":...,"caller":...,"scope":...,"count":n,...}` per COORDINATOR STREAM at its 1st, 2nd, 4th,
// 8th ... occurrence of a decision (src/upstream-cooldown.js `record`), `count` being the running count of that coordinator. A stream is one coordinator and one decision kind: it is NOT
// necessarily a business run (a caller creates one coordinator per phase, per step or per request), and a decision is NOT a request: a decision is counted where a guard looked at the scope
// (the removal path looks twice for one lookup, once before its claim and once at the request; the two sites carry different callers). The lines carry no stream id. For one key
// (caller, scope, decision), let r_j be the number of lines with count = 2^j. A stream that logged 2^j also logged every lower power, so the streams whose last logged count is 2^j number
// r_j - r_(j+1), and each made between 2^j and 2^(j+1)-1 decisions:
//   lower = sum (r_j - r_(j+1)) * 2^j        upper = sum (r_j - r_(j+1)) * (2^(j+1) - 1)        streams = r_0
// CONDITIONAL ON COMPLETENESS. The bounds are exact only for a COMPLETE export of COMPLETE streams. A whole missing stream, a missing tail, a truncated query or an overlapping export can
// all pass the arithmetic (and a real run can be missing from the logs although its effects are in D1). This tool therefore NEVER proves completeness and NEVER says "clean": its evidence
// status is `none` (no event: not a zero), `insufficient` (a defect was found) or `conditional` (observed counts, completeness unproven), and `uc3Eligible` is always false: whether the
// evidence is representative enough is a human judgement made against the natural run history, not an output of this script.
//
// INPUT SHAPES. A plain log line, or the structured event the telemetry query returns (an object with `source` = the parsed log body, `timestamp` and `$metadata.id`). A structured event with
// an id is de-duplicated by that id (a second copy is counted and flagged, never counted twice); a plain line has no identity, so duplicates in it cannot be detected (`identity_unverified`).
//
// Usage: node scripts/upstream-cooldown-evidence-report.mjs [--format json|markdown] [--query-limit N] [file ...]     (no file: stdin)
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const DECISIONS=['would_skip','written','write_failed','skipped'];
const LINE=/\{"event":"upstream_cooldown".*\}/;
const isPower=n=>Number.isInteger(n)&&n>=1&&(n&(n-1))===0;
const valid=event=>Boolean(event)&&event.event==='upstream_cooldown'&&DECISIONS.includes(event.decision)&&typeof event.caller==='string'&&typeof event.scope==='string'&&Number.isInteger(event.count)&&event.count>=1;
const timeOf=value=>{
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value==='string'&&value){const at=Date.parse(value);return Number.isFinite(at)?at:null;}
 return null;
};

// One log line -> {event, id, at} or null (not an upstream_cooldown line, or malformed). `id` and `at` exist only for a structured event.
export function parseLine(line){
 const text=String(line).trim();
 if(!text.includes('upstream_cooldown'))return null;
 if(text.startsWith('{')){
  let wrapper=null;
  try{wrapper=JSON.parse(text);}catch{wrapper=null;}
  if(wrapper&&typeof wrapper==='object'){
   let body=wrapper.source&&typeof wrapper.source==='object'?wrapper.source:wrapper;
   if(typeof body.message==='string'&&body.event===undefined){try{body=JSON.parse(body.message);}catch{body=null;}}
   if(valid(body)){
    const id=wrapper.$metadata?.id??wrapper.id??wrapper.eventId??null;
    return {event:body,id:id===null?null:String(id),at:timeOf(wrapper.timestamp??wrapper.$metadata?.timestamp??null)};
   }
   if(body&&body!==wrapper||wrapper.event==='upstream_cooldown')return null;
  }
 }
 const match=LINE.exec(text);
 if(!match)return null;
 let event;
 try{event=JSON.parse(match[0]);}catch{return null;}
 return valid(event)?{event,id:null,at:null}:null;
}

// `queryLimit` is the limit of the ONE query that produced `lines`: the export is flagged `possibly_truncated` when the records it returned (non-blank lines, de-duplication and non-matching
// records included) reach that limit. Several exports are checked one by one in `aggregateFiles`, never as a sum.
export function aggregate(lines,{queryLimit=null}={}){
 const keys=new Map();
 const seen=new Set();
 let events=0,ignored=0,malformed=0,duplicates=0,unidentified=0,records=0;
 for(const line of lines){
  const text=String(line);
  if(text.trim())records++;
  if(!text.includes('upstream_cooldown')){ignored++;continue;}
  const parsed=parseLine(text);
  if(!parsed){malformed++;continue;}
  if(parsed.id!==null){
   if(seen.has(parsed.id)){duplicates++;continue;}
   seen.add(parsed.id);
  }else unidentified++;
  const {event}=parsed;
  events++;
  const id=event.caller+'\u0000'+event.scope+'\u0000'+event.decision;
  if(!keys.has(id))keys.set(id,{caller:event.caller,scope:event.scope,decision:event.decision,lines:0,power:new Map(),invalidCounts:0,maxCount:0,reasons:{},secondsAsked:{}});
  const entry=keys.get(id);
  entry.lines++;
  if(isPower(event.count))entry.power.set(Math.log2(event.count),(entry.power.get(Math.log2(event.count))||0)+1);else entry.invalidCounts++;
  entry.maxCount=Math.max(entry.maxCount,event.count);
  if(typeof event.reason==='string')entry.reasons[event.reason]=(entry.reasons[event.reason]||0)+1;
  if(Number.isInteger(event.seconds)&&typeof event.reason==='string')entry.secondsAsked[event.reason]=(entry.secondsAsked[event.reason]||0)+event.seconds;
 }
 const rows=[];
 for(const entry of keys.values()){
  const top=Math.max(-1,...entry.power.keys());
  let lower=0,upper=0,inconsistent=false;
  for(let j=0;j<=top;j++){
   const here=entry.power.get(j)||0,next=entry.power.get(j+1)||0;
   if(next>here)inconsistent=true;
   const ended=Math.max(0,here-next);
   lower+=ended*2**j;upper+=ended*(2**(j+1)-1);
  }
  rows.push({caller:entry.caller,scope:entry.scope,decision:entry.decision,lines:entry.lines,streams:entry.power.get(0)||0,lower,upper,maxCount:entry.maxCount,reasons:entry.reasons,
   ...(Object.keys(entry.secondsAsked).length?{cooldownSecondsLogged:entry.secondsAsked}:{}),...(entry.invalidCounts?{invalidCounts:entry.invalidCounts}:{}),...(inconsistent?{inconsistent:true}:{})});
 }
 rows.sort((a,b)=>a.scope.localeCompare(b.scope)||a.caller.localeCompare(b.caller)||DECISIONS.indexOf(a.decision)-DECISIONS.indexOf(b.decision));
 const total=decision=>{const part=rows.filter(row=>row.decision===decision);return {lower:part.reduce((sum,row)=>sum+row.lower,0),upper:part.reduce((sum,row)=>sum+row.upper,0),lines:part.reduce((sum,row)=>sum+row.lines,0)};};
 const byScope={};
 for(const scope of [...new Set(rows.map(row=>row.scope))].sort()){
  byScope[scope]={};
  for(const decision of DECISIONS){const part=rows.filter(row=>row.scope===scope&&row.decision===decision);if(part.length)byScope[scope][decision]={lower:part.reduce((s,r)=>s+r.lower,0),upper:part.reduce((s,r)=>s+r.upper,0)};}
 }
 const totals=Object.fromEntries(DECISIONS.map(decision=>[decision,total(decision)]));
 // Defects FOUND. An `enforce` decision (`skipped`) in observe, a failed cooldown write, an inconsistent, truncated, overlapping or empty export each stop the evidence from being read as complete.
 const flags=[];
 if(events===0)flags.push('no_events');
 if(totals.skipped.lines>0)flags.push('actual_skips');
 if(totals.write_failed.lines>0)flags.push('write_failed');
 if(rows.some(row=>row.inconsistent||row.invalidCounts))flags.push('inconsistent_export');
 if(malformed>0)flags.push('malformed_lines');
 if(duplicates>0)flags.push('duplicate_events');
 if(Number.isInteger(queryLimit)&&queryLimit>0&&records>=queryLimit)flags.push('possibly_truncated');
 // Conditions this script cannot verify, whatever it found.
 const limits=['completeness_unproven'];
 if(unidentified>0)limits.push('identity_unverified');
 const status=events===0?'none':flags.length?'insufficient':'conditional';
 return {records,events,ignoredLines:ignored,malformedLines:malformed,duplicateEvents:duplicates,unidentifiedEvents:unidentified,rows,byScope,totals,flags,limits,evidence:{status,completenessProven:false,uc3Eligible:false}};
}

// Several exports at once: the same file twice or an event id in two files means the windows overlap; the files' time ranges are reported when their events carry timestamps.
export function aggregateFiles(files,{queryLimit=null}={}){
 const digests=new Map(),ids=new Map(),ranges=[],info=[];
 const extra=[];
 for(const file of files){
  const lines=file.text.split('\n');
  const records=lines.filter(line=>line.trim()).length;
  let events=0,min=Infinity,max=-Infinity;
  for(const line of lines){
   const parsed=parseLine(line);
   if(!parsed)continue;
   events++;
   if(parsed.id!==null){if(ids.has(parsed.id)&&ids.get(parsed.id)!==file.name)extra.push('overlapping_exports');else ids.set(parsed.id,file.name);}
   if(parsed.at!==null){min=Math.min(min,parsed.at);max=Math.max(max,parsed.at);}
  }
  // The same CONTENT twice is a duplicate export; two empty exports are not (they hash alike and prove nothing, which `no_events` already says).
  if(events>0){
   const digest=createHash('sha256').update(file.text).digest('hex');
   if(digests.has(digest))extra.push('duplicate_files');else digests.set(digest,file.name);
  }
  // Each export is one query with its own limit: only an individual file that reaches it is possibly truncated.
  if(Number.isInteger(queryLimit)&&queryLimit>0&&records>=queryLimit)extra.push('possibly_truncated');
  info.push({name:file.name,records,events,...(min!==Infinity?{from:new Date(min).toISOString(),to:new Date(max).toISOString()}:{})});
  if(min!==Infinity)ranges.push({name:file.name,fromMs:min,toMs:max});
 }
 ranges.sort((a,b)=>a.fromMs-b.fromMs);
 for(let i=1;i<ranges.length;i++)if(ranges[i].fromMs<=ranges[i-1].toMs)extra.push('overlapping_exports');
 // The decision accounting stays global over every export.
 const report=aggregate(files.flatMap(file=>file.text.split('\n')));
 for(const flag of new Set(extra))if(!report.flags.includes(flag))report.flags.push(flag);
 if(extra.length&&report.evidence.status==='conditional')report.evidence.status='insufficient';
 report.files=info;
 return report;
}

export function markdown(report){
 const out=[];
 out.push('## Decisions per scope, caller and decision','');
 out.push('A decision is counted where a guard looked at the scope; it is not a sent or a prevented request. A stream is one coordinator, not necessarily one business run. Ranges are conditional on a complete export.','');
 out.push('| Scope | Caller | Decision | Log lines | Streams | Decisions (lower - upper) | Max running count | Reasons |','| --- | --- | --- | ---: | ---: | --- | ---: | --- |');
 for(const row of report.rows)out.push(`| ${row.scope} | ${row.caller} | ${row.decision} | ${row.lines} | ${row.streams} | ${row.lower} - ${row.upper} | ${row.maxCount} | ${Object.entries(row.reasons).map(([k,v])=>k+' x'+v).join(', ')||'-'} |`);
 if(!report.rows.length)out.push('| - | - | - | 0 | 0 | 0 - 0 | 0 | - |');
 out.push('','## Totals','','| Decision | Log lines | Decisions (lower - upper) |','| --- | ---: | --- |');
 for(const decision of DECISIONS)out.push(`| ${decision} | ${report.totals[decision].lines} | ${report.totals[decision].lower} - ${report.totals[decision].upper} |`);
 out.push('',`Events ${report.events}; duplicate events dropped ${report.duplicateEvents}; events without an id ${report.unidentifiedEvents}; other log lines ${report.ignoredLines}; malformed upstream_cooldown lines ${report.malformedLines}.`);
 out.push(`Flags: ${report.flags.length?report.flags.join(', '):'none'}. Limits: ${report.limits.join(', ')}.`);
 const note={none:'NO EVIDENCE: no upstream_cooldown event was found. This is not a zero count and not evidence that nothing happened.',insufficient:'INSUFFICIENT: a defect was found (see the flags); read nothing as complete.',conditional:'CONDITIONAL: observed counts and bounds that hold only for a complete export; completeness is not proven. This report is not a UC3 GO.'}[report.evidence.status];
 out.push(`Evidence status: ${report.evidence.status}. ${note}`);
 if(report.files?.length)out.push('Exports: '+report.files.map(file=>`${file.name} ${file.records} records, ${file.events} events${file.from?`, ${file.from} .. ${file.to}`:''}`).join('; ')+'.');
 return out.join('\n')+'\n';
}

export function parseArgs(argv){
 const args=argv.slice(2);
 let format='markdown',queryLimit=null;const files=[];
 for(let i=0;i<args.length;i++){
  if(args[i]==='--format'){const value=args[++i];if(value!=='json'&&value!=='markdown')throw new Error('usage');format=value;}
  else if(args[i]==='--query-limit'){const value=args[++i];if(!/^[1-9]\d{0,8}$/.test(value||''))throw new Error('usage');queryLimit=Number(value);}
  else if(args[i].startsWith('--'))throw new Error('usage');
  else files.push(args[i]);
 }
 return {format,files,queryLimit};
}

const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 let parsed;
 try{parsed=parseArgs(process.argv);}catch{process.stderr.write('usage: upstream-cooldown-evidence-report.mjs [--format json|markdown] [--query-limit N] [file ...]\n');process.exit(2);}
 const report=parsed.files.length?aggregateFiles(parsed.files.map(name=>({name,text:fs.readFileSync(name,'utf8')})),{queryLimit:parsed.queryLimit}):aggregate(fs.readFileSync(0,'utf8').split('\n'),{queryLimit:parsed.queryLimit});
 process.stdout.write(parsed.format==='json'?JSON.stringify(report,null,1)+'\n':markdown(report));
}
