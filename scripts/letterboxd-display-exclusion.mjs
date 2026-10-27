// Offline builder of the private Finds display-exclusion list (ADR-0028). It reads the owner's export ZIP and a verified
// baseline import plan of that export, re-derives the plan's accepted films from the snapshot the plan was made from, and
// writes the normalized names and years of the watched or rated films that still have no accepted identity. No network, no
// R2: placing the list is a separate owner-approved operation. Names stay in the private output file; standard output
// carries counts only.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EXPORT_FILES,parseExport} from '../src/letterboxd-export.js';
import {buildIndex,matchExport,normTitle} from '../src/letterboxd-match.js';
import {readZip} from '../src/letterboxd-zip.js';
import {ImportError,loadVerifiedPlan,planItem} from './letterboxd-baseline-import.mjs';
import {ReconcileError,assertOutsideRepository,loadSnapshot} from './letterboxd-reconcile.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
export const MAX_ENTRIES=20000;
const canonical=items=>JSON.stringify(items.map(item=>JSON.stringify(item)).sort());

export async function build({zip,plan,snapshot,output,now=Date.now()}){
 const outputPath=await assertOutsideRepository(output,'--output'),snapshotPath=await assertOutsideRepository(snapshot,'--snapshot');
 // The plan binds the archive: loadVerifiedPlan refuses an archive or a plan that differs from origin.json.
 const {origin,chunks}=await loadVerifiedPlan({zip,output:plan,now});
 const {files}=readZip(await readFile(zip),Object.values(EXPORT_FILES));
 const parsed=parseExport(Object.fromEntries(Object.entries(EXPORT_FILES).map(([kind,name])=>[kind,files[name]?.text??null])));
 const matches=matchExport(parsed.films,buildIndex((await loadSnapshot(snapshotPath)).objects)),films=new Map(parsed.films.map(film=>[film.code,film]));
 // The snapshot must reproduce the plan exactly, so the accepted identities are the plan's and never an empty fallback.
 const accepted=matches.filter(match=>match.status==='accepted');
 if(canonical(accepted.map(match=>planItem(films.get(match.code),match)))!==canonical(chunks.flat()))throw new ImportError('The snapshot does not reproduce the baseline plan',3);
 const identified=new Set(accepted.map(match=>match.code)),names=new Map();
 for(const film of parsed.films){const key=normTitle(film.name);if(key)names.set(key,(names.get(key)||0)+1);}
 const counts={exportFilms:0,withIdentity:0,droppedNoYear:0,droppedNoName:0,droppedExportNamesake:0,entries:0},entries=[];
 for(const film of parsed.films){
  if(!film.inWatched&&!film.inRatings)continue;
  counts.exportFilms++;
  const key=normTitle(film.name);
  if(identified.has(film.code))counts.withIdentity++;
  else if(!Number.isInteger(film.year))counts.droppedNoYear++;
  else if(!key)counts.droppedNoName++;
  // A name the export carries more than once, in any year, could be either film.
  else if(names.get(key)>1)counts.droppedExportNamesake++;
  else entries.push({title:key,year:film.year});
 }
 entries.sort((a,b)=>a.title<b.title?-1:a.title>b.title?1:a.year-b.year);
 if(entries.length>MAX_ENTRIES)throw new ImportError('The list would exceed '+MAX_ENTRIES+' entries',3);
 counts.entries=entries.length;
 const list={schemaVersion:1,kind:'letterboxd_display_exclusion',rule:'strict_original_exact_year',normalization:'normTitle_v1',
  source:{type:'letterboxd_export',archiveSha256:origin.archiveSha256,exportedAt:origin.generatedAt,baselinePlanSha256:origin.planSha256},
  builtAt:new Date(now).toISOString(),counts,entries,contentSha256:sha256(JSON.stringify(entries))};
 // Create-only and owner-readable only: the list is private watch history.
 await writeFile(outputPath,JSON.stringify(list)+'\n',{mode:0o600,flag:'wx'});
 return {schemaVersion:1,tool:'letterboxd-display-exclusion',privacy:'Aggregate counts only. Names are in the private output file.',counts};
}

function parseArgs(argv){
 const [mode,...rest]=argv,args={mode},names={'--zip':'zip','--plan':'plan','--snapshot':'snapshot','--output':'output'};
 for(let i=0;i<rest.length;i++){const name=names[rest[i]];if(!name||i+1>=rest.length)throw new ImportError('Usage: letterboxd-display-exclusion.mjs build --zip <abs> --plan <abs plan dir> --snapshot <abs> --output <abs file>',2);args[name]=rest[++i];}
 if(mode!=='build'||!args.zip||!args.plan||!args.snapshot||!args.output)throw new ImportError('build needs --zip, --plan, --snapshot and --output',2);
 return args;
}
async function main(){
 try{console.log(JSON.stringify(await build(parseArgs(process.argv.slice(2)))));}
 catch(error){
  const known=error instanceof ImportError||error instanceof ReconcileError||error?.name==='ZipError'||error?.name==='CsvError';
  console.error(known?error.message:error?.code==='EEXIST'?'--output already exists; build into a new file':'Display exclusion build failed');process.exit(error.exitCode||1);
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
