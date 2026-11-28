#!/usr/bin/env node
// Offline aggregator of the UC2 observe evidence (AIR-609; ADR 0211 decision 5). Reads Worker log text (one or more files, or stdin) that was exported by a SEPARATE authorized read
// of the Worker `iptv` logs, and prints the per caller x scope x decision accounting. It makes no network call, reads no database and writes nothing but its own stdout.
//
// The Worker writes one JSON line `{"event":"upstream_cooldown","decision":...,"caller":...,"scope":...,"count":n,...}` per coordinator at its 1st, 2nd, 4th, 8th ... occurrence
// of a decision (src/upstream-cooldown.js `record`), `count` being the running count of THAT coordinator (one run of one caller). The log therefore carries a logarithmic sample,
// not every decision, and no run id. For one key (caller, scope, decision), let r_j be the number of lines with count = 2^j. A run that logged 2^j also logged every lower
// power, so the runs whose last logged count is 2^j number r_j - r_(j+1), and each such run made between 2^j and 2^(j+1)-1 decisions. Hence the exact bounds
//   lower = sum (r_j - r_(j+1)) * 2^j        upper = sum (r_j - r_(j+1)) * (2^(j+1) - 1)
// and `runs = r_0`. The bounds hold when the export is complete for the window; an inconsistent export (r_(j+1) > r_j, a count that is not a power of two) is flagged, never hidden.
//
// Usage: node scripts/upstream-cooldown-evidence-report.mjs [--format json|markdown] [file ...]     (no file: stdin)
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export const DECISIONS=['would_skip','written','write_failed','skipped'];
const LINE=/\{"event":"upstream_cooldown".*\}/;
const isPower=n=>Number.isInteger(n)&&n>=1&&(n&(n-1))===0;

// One log line -> the event, or null (not an upstream_cooldown line, or malformed).
export function parseLine(line){
 const match=LINE.exec(String(line));
 if(!match)return null;
 // A log wrapper may escape the quotes of an embedded message; try the plain form first.
 let event;
 try{event=JSON.parse(match[0]);}catch{return null;}
 if(!event||event.event!=='upstream_cooldown')return null;
 if(!DECISIONS.includes(event.decision)||typeof event.caller!=='string'||typeof event.scope!=='string'||!Number.isInteger(event.count))return null;
 return event;
}

export function aggregate(lines){
 const keys=new Map();
 let events=0,ignored=0,malformed=0;
 for(const line of lines){
  const text=String(line);
  if(!text.includes('upstream_cooldown')){ignored++;continue;}
  const event=parseLine(text);
  if(!event){malformed++;continue;}
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
  rows.push({caller:entry.caller,scope:entry.scope,decision:entry.decision,lines:entry.lines,runs:entry.power.get(0)||0,lower,upper,maxCount:entry.maxCount,reasons:entry.reasons,
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
 // Acceptance flags of the card: an `enforce` decision (`skipped`) in observe is a defect; a failed cooldown write and an inconsistent export need a look.
 const flags=[];
 if(totals.skipped.lines>0)flags.push('actual_skips');
 if(totals.write_failed.lines>0)flags.push('write_failed');
 if(rows.some(row=>row.inconsistent||row.invalidCounts))flags.push('inconsistent_export');
 if(malformed>0)flags.push('malformed_lines');
 return {events,ignoredLines:ignored,malformedLines:malformed,rows,byScope,totals,flags};
}

export function markdown(report){
 const out=[];
 out.push('## Decisions per scope, caller and decision','');
 out.push('| Scope | Caller | Decision | Log lines | Runs | Decisions (lower - upper) | Max running count | Reasons |','| --- | --- | --- | ---: | ---: | --- | ---: | --- |');
 for(const row of report.rows)out.push(`| ${row.scope} | ${row.caller} | ${row.decision} | ${row.lines} | ${row.runs} | ${row.lower} - ${row.upper} | ${row.maxCount} | ${Object.entries(row.reasons).map(([k,v])=>k+' x'+v).join(', ')||'-'} |`);
 if(!report.rows.length)out.push('| - | - | - | 0 | 0 | 0 - 0 | 0 | - |');
 out.push('','## Totals','','| Decision | Log lines | Decisions (lower - upper) |','| --- | ---: | --- |');
 for(const decision of DECISIONS)out.push(`| ${decision} | ${report.totals[decision].lines} | ${report.totals[decision].lower} - ${report.totals[decision].upper} |`);
 out.push('',`Events ${report.events}; other log lines ${report.ignoredLines}; malformed upstream_cooldown lines ${report.malformedLines}.`,`Flags: ${report.flags.length?report.flags.join(', '):'none'}.`);
 return out.join('\n')+'\n';
}

export function parseArgs(argv){
 const args=argv.slice(2);
 let format='markdown';const files=[];
 for(let i=0;i<args.length;i++){
  if(args[i]==='--format'){const value=args[++i];if(value!=='json'&&value!=='markdown')throw new Error('usage');format=value;}
  else if(args[i].startsWith('--'))throw new Error('usage');
  else files.push(args[i]);
 }
 return {format,files};
}

const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 let parsed;
 try{parsed=parseArgs(process.argv);}catch{process.stderr.write('usage: upstream-cooldown-evidence-report.mjs [--format json|markdown] [file ...]\n');process.exit(2);}
 const text=parsed.files.length?parsed.files.map(file=>fs.readFileSync(file,'utf8')).join('\n'):fs.readFileSync(0,'utf8');
 const report=aggregate(text.split('\n'));
 process.stdout.write(parsed.format==='json'?JSON.stringify(report,null,1)+'\n':markdown(report));
}
