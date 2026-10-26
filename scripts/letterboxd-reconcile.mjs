// Offline reconciliation of a Letterboxd account export with an R2 snapshot taken by r2-snapshot-export.mjs.
// It reads four named CSV files of the extracted export and, when given, a fenced consistent snapshot directory.
// It sends no network request and writes only report.json (aggregate counts) and matches.jsonl (private rows)
// inside an output directory outside this repository. Film names never reach stdout or report.json.
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXPORT_FILES,SET_NAMES,filmSets,parseExport} from '../src/letterboxd-export.js';
import {METHODS,STATUSES,buildIndex,lidHypothesis,matchExport} from '../src/letterboxd-match.js';

const REPO_ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const SNAPSHOT_KEYS=Object.freeze({watchlist:'watchlist.json',programme:'programme.json',metadata:'metadata.json',catalog:'epg/discovered-films.json',viewIndex:'enrichment/view-index.json',ratingsPointer:'enrichment/ratings/published.json'});
const ratingsGenerationKey=id=>'enrichment/ratings/generations/'+encodeURIComponent(id)+'.json';
const sha256=value=>createHash('sha256').update(value).digest('hex');

export class ReconcileError extends Error{constructor(message,exitCode=1){super(message);this.name='ReconcileError';this.exitCode=exitCode;}}

// The nearest existing ancestor is resolved through symlinks, so a link into the repository is refused too.
async function resolvedPath(target){
 let current=path.resolve(target),rest=[];
 while(true){try{return path.join(await realpath(current),...rest);}catch{const parent=path.dirname(current);if(parent===current)return path.resolve(target);rest.unshift(path.basename(current));current=parent;}}
}
export async function assertOutsideRepository(target,label,root=REPO_ROOT){
 if(typeof target!=='string'||!path.isAbsolute(target))throw new ReconcileError(label+' must be an absolute path',2);
 const resolved=await resolvedPath(target),repo=await resolvedPath(root);
 if(resolved===repo||resolved.startsWith(repo+path.sep))throw new ReconcileError(label+' must be outside the Git repository',2);
 return resolved;
}

async function readExport(directory){
 const files={};
 for(const [kind,name] of Object.entries(EXPORT_FILES)){
  try{files[kind]=await readFile(path.join(directory,name),'utf8');}
  catch(error){if(error.code!=='ENOENT')throw new ReconcileError('Export file '+name+' could not be read');files[kind]=null;}
 }
 if(files.watched===null)throw new ReconcileError('Export directory has no '+EXPORT_FILES.watched,2);
 return files;
}

// Reads only the named keys of a production snapshot and checks each against the manifest checksum.
export async function loadSnapshot(directory){
 let manifest;
 try{manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));}catch{throw new ReconcileError('Snapshot manifest is missing or not JSON',2);}
 if(manifest?.schemaVersion!==1||!Array.isArray(manifest.objects))throw new ReconcileError('Snapshot manifest schema is not supported',2);
 if(manifest.source?.kind!=='cloudflare-r2-s3')throw new ReconcileError('Snapshot is not a production R2 export',3);
 if(manifest.status!=='consistent_fenced'||!Array.isArray(manifest.noGoReasons)||manifest.noGoReasons.length||manifest.fence?.ok!==true||(manifest.changes||[]).length)throw new ReconcileError('Snapshot is not a fenced consistent cut',3);
 const byKey=new Map(manifest.objects.map(entry=>[entry?.key,entry]));
 const load=async key=>{
  const entry=byKey.get(key);if(!entry)return undefined;
  if(entry.file!=='objects/'+sha256(Buffer.from(key,'utf8'))+'.bin')throw new ReconcileError('Snapshot object path is not the key hash',3);
  const bytes=await readFile(path.join(directory,entry.file));
  if(bytes.length!==entry.size||sha256(bytes)!==entry.sha256)throw new ReconcileError('Snapshot checksum mismatch',3);
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw new ReconcileError('Snapshot object is not JSON',3);}
 };
 const objects={},missing=[];
 for(const [name,key] of Object.entries(SNAPSHOT_KEYS)){const value=await load(key);if(value===undefined)missing.push(key);else objects[name]=value;}
 const pointer=objects.ratingsPointer;
 if(pointer?.projected===true&&typeof pointer.generationId==='string'){
  const key=ratingsGenerationKey(pointer.generationId),value=await load(key);
  if(value===undefined)missing.push('enrichment/ratings/generations/<published>.json');else objects.ratings=value;
 }else if(pointer)missing.push('enrichment/ratings/published.json:not_projected');
 return {objects,missing,status:manifest.status,baselineIdentity:manifest.baselineIdentity??null};
}

const zero=names=>Object.fromEntries(names.map(name=>[name,0]));
function exportSummary(parsed){
 return {files:parsed.files,sets:Object.fromEntries(SET_NAMES.map(name=>[name,parsed.sets[name].length])),films:parsed.films.length,crossFileMismatches:parsed.crossFileMismatches,invalidRows:parsed.invalidRows.length};
}
function matchSummary(parsed,matches){
 const sets=new Map(parsed.films.map(film=>[film.code,filmSets(film)]));
 const byStatus=zero(STATUSES),byMethod=zero(METHODS),reasons={},bySet=Object.fromEntries(SET_NAMES.map(name=>[name,{total:0,byStatus:zero(STATUSES),acceptedByMethod:zero(METHODS)}]));
 for(const row of matches){
  byStatus[row.status]++;if(row.status==='accepted')byMethod[row.method]++;if(row.reason)reasons[row.reason]=(reasons[row.reason]||0)+1;
  for(const name of sets.get(row.code)){const bucket=bySet[name];bucket.total++;bucket.byStatus[row.status]++;if(row.status==='accepted')bucket.acceptedByMethod[row.method]++;}
 }
 return {byStatus,acceptedByMethod:byMethod,reasons:Object.fromEntries(Object.entries(reasons).sort(([a],[b])=>a<b?-1:1)),bySet,catalogLinked:matches.filter(row=>row.status==='accepted'&&row.catalogIds.length).length};
}

export async function reconcile({exportDir,snapshotDir=null,outputDir}){
 const output=await assertOutsideRepository(outputDir,'--output');
 const exportPath=await assertOutsideRepository(exportDir,'--export');
 const snapshotPath=snapshotDir?await assertOutsideRepository(snapshotDir,'--snapshot'):null;
 const parsed=parseExport(await readExport(exportPath));
 const report={schemaVersion:1,tool:'letterboxd-reconcile',privacy:'Aggregate counts only. Per-film rows are in the private matches.jsonl next to this file.',export:exportSummary(parsed),matching:null,notes:[...parsed.notes]};
 const rows=parsed.invalidRows.map(row=>({type:'invalid_row',...row}));
 if(!snapshotPath)report.matching={blocked:'snapshot_missing'};
 else{
  const snapshot=await loadSnapshot(snapshotPath),index=buildIndex(snapshot.objects),matches=matchExport(parsed.films,index);
  const films=new Map(parsed.films.map(film=>[film.code,film]));
  report.matching={blocked:null,snapshot:{status:snapshot.status,baselineIdentity:snapshot.baselineIdentity,missingKeys:snapshot.missing},index:index.summary,...matchSummary(parsed,matches),lidHypothesis:lidHypothesis(matches,index)};
  for(const key of snapshot.missing)report.notes.push('snapshot_missing_key:'+key);
  for(const match of matches){const film=films.get(match.code);rows.push({type:'match',...match,uri:film.uri,name:film.name,year:film.year,rating:film.rating??null,watchedDate:film.watchedDate??null,sets:filmSets(film)});}
 }
 await mkdir(output,{recursive:true,mode:0o700});
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,1)+'\n',{mode:0o600});
 await writeFile(path.join(output,'matches.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':''),{mode:0o600});
 return report;
}

function parseArgs(argv){
 const args={};
 for(let i=0;i<argv.length;i++){
  const flag=argv[i],name={'--export':'exportDir','--snapshot':'snapshotDir','--output':'outputDir'}[flag];
  if(!name||i+1>=argv.length||argv[i+1].startsWith('--'))throw new ReconcileError('Usage: letterboxd-reconcile.mjs --export <abs dir> [--snapshot <abs dir>] --output <abs dir outside the repository>',2);
  args[name]=argv[++i];
 }
 if(!args.exportDir||!args.outputDir)throw new ReconcileError('--export and --output are required',2);
 return args;
}

async function main(){
 try{
  const report=await reconcile(parseArgs(process.argv.slice(2))),m=report.matching;
  // Counts only: the summary never carries a title, URI, code or rating.
  console.log(JSON.stringify({sets:report.export.sets,invalidRows:report.export.invalidRows,matching:m.blocked?{blocked:m.blocked}:{byStatus:m.byStatus,acceptedByMethod:m.acceptedByMethod,lidHypothesis:m.lidHypothesis.verdict}}));
 }catch(error){
  const known=error instanceof ReconcileError||error?.name==='CsvError';
  console.error(known?error.message+(error.record?' (record '+error.record+')':''):'Reconciliation failed');
  process.exit(error.exitCode||1);
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
