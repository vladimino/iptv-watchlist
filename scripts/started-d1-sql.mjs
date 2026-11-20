// Offline SQL generator for the Started marks R2 -> D1 cutover (schema v29). It reads a LOCAL export of the R2 `started/` objects and prints guarded SQL
// to stdout. It opens no database, no bucket and no network connection, and it applies nothing: the operator applies the printed SQL only under an owner GO
// (docs/runbooks/started-marks-cutover.md).
//
//   node scripts/started-d1-sql.mjs hold
//   node scripts/started-d1-sql.mjs import   <started-export.json>
//   node scripts/started-d1-sql.mjs activate <started-export.json>
//   node scripts/started-d1-sql.mjs release
//   node scripts/started-d1-sql.mjs digest   <started-export.json>
//
// The export is a JSON array, one entry per object of a COMPLETE listing of the prefix `started/` (tombstones and inactive marks included):
//   {"key":"started/<id>.json","etag":"<strong etag>","customMetadata":{"started":"true"},"body":"<the raw object text>"}
// Anything the Worker would read differently is a blocker (exit 2, no SQL): not an array, a duplicate or foreign key, a key outside `started/<[a-zA-Z0-9_-]{1,80}>.json`,
// a body that is not a JSON object, a body id that differs from the key, a `started` flag that disagrees with `customMetadata.started` (the list read and the write read
// would disagree), a `startedAt` that is neither a string nor null, a `lastEvent` that is not an object with a string id. It never turns a broken source into a partial or empty
// import. The event journal `events/items/` is not read or copied here, and no event is created.
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY=/^started\/([a-zA-Z0-9_-]{1,80})\.json$/;
const sql=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const blocker=message=>Object.assign(new Error(message),{blocker:true});
// R2 lists in key order: the rows are written in that order so every printout is stable.
const byKey=(a,b)=>a.key<b.key?-1:a.key>b.key?1:0;
export function normalizeExport(data){
 if(!Array.isArray(data))throw blocker('the export is not an array of objects');
 const seen=new Set(),marks=[];
 for(const entry of [...data].sort((a,b)=>byKey(a||{},b||{}))){
  if(!entry||typeof entry!=='object'||typeof entry.key!=='string'||typeof entry.body!=='string')throw blocker('an export entry has no key or raw body');
  const match=KEY.exec(entry.key);
  if(!match)throw blocker('an object key is outside started/<id>.json: '+entry.key);
  if(seen.has(entry.key))throw blocker('a key appears twice: '+entry.key);
  seen.add(entry.key);
  let body;
  try{body=JSON.parse(entry.body);}catch{throw blocker('an object body is not JSON: '+entry.key);}
  if(!body||typeof body!=='object'||Array.isArray(body))throw blocker('an object body is not a JSON object: '+entry.key);
  if(body.id!==match[1])throw blocker('the body id differs from the key: '+entry.key);
  const started=body.started!==false,flag=entry.customMetadata?.started;
  if(flag!==undefined&&flag!==String(started))throw blocker('customMetadata.started disagrees with the body: '+entry.key);
  if(body.startedAt!==undefined&&body.startedAt!==null&&typeof body.startedAt!=='string')throw blocker('startedAt is neither a string nor null: '+entry.key);
  let lastEvent=null;
  if(body.lastEvent!==undefined&&body.lastEvent!==null){
   if(typeof body.lastEvent!=='object'||Array.isArray(body.lastEvent)||typeof body.lastEvent.id!=='string')throw blocker('lastEvent is not an object with an id: '+entry.key);
   lastEvent=JSON.stringify(body.lastEvent);
  }
  marks.push({id:match[1],started,startedAt:body.startedAt??null,lastEvent,etag:typeof entry.etag==='string'?entry.etag:null});
 }
 return marks;
}
export function readSource(file){
 let data;
 try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw blocker('the export is not readable JSON');}
 return normalizeExport(data);
}
export function digestOf(marks){
 const rows=crypto.createHash('sha256').update(JSON.stringify(marks.map(mark=>[mark.id,mark.started,mark.startedAt,mark.lastEvent]))).digest('hex');
 const etags=crypto.createHash('sha256').update(JSON.stringify(marks.map(mark=>[mark.id,mark.etag]))).digest('hex');
 return {count:marks.length,started:marks.filter(mark=>mark.started).length,sha256:rows,etagsSha256:etags};
}
export function holdSql(){
 return "UPDATE started_authority SET writes='held' WHERE id=1 AND mode='r2' AND writes='open' AND generation=0;\nUPDATE started_cas SET ok=changes() WHERE id=1;\n";
}
export function releaseSql(){
 return "UPDATE started_authority SET writes='open' WHERE id=1 AND mode='r2' AND writes='held' AND generation IN (0,1);\nUPDATE started_cas SET ok=changes() WHERE id=1;\n";
}
function checked(lines){
 for(const line of lines)if(Buffer.byteLength(line)>90000)throw blocker('one statement would exceed the D1 statement limit');
 return lines.join('\n')+'\n';
}
export function importSql(marks){
 const lines=[
  "UPDATE started_authority SET generation=1 WHERE id=1 AND mode='r2' AND writes='held' AND generation=0 AND (SELECT COUNT(*) FROM started_mark)=0;",
  'UPDATE started_cas SET ok=changes() WHERE id=1;',
 ];
 for(const mark of marks)lines.push('INSERT INTO started_mark (id,started,started_at,last_event_json,rev) VALUES ('+[sql(mark.id),mark.started?1:0,sql(mark.startedAt),sql(mark.lastEvent),1].join(',')+');');
 return checked(lines);
}
// One short parity statement per mark (it aborts the file when that row differs, through the fence row's CHECK), then one guarded switch.
export function activateSql(marks){
 const lines=[];
 for(const mark of marks)lines.push('UPDATE started_cas SET ok=(SELECT COUNT(*) FROM started_mark WHERE id='+sql(mark.id)+' AND started='+(mark.started?1:0)+' AND started_at IS '+sql(mark.startedAt)+' AND last_event_json IS '+sql(mark.lastEvent)+' AND rev=1) WHERE id=1;');
 const started=marks.filter(mark=>mark.started).length;
 lines.push("UPDATE started_authority SET mode='d1', writes='open' WHERE id=1 AND mode='r2' AND writes='held' AND generation=1 AND (SELECT COUNT(*) FROM started_mark)="+marks.length+' AND (SELECT COUNT(*) FROM started_mark WHERE started=1)='+started+';');
 lines.push('UPDATE started_cas SET ok=changes() WHERE id=1;');
 return checked(lines);
}
function main(argv){
 const [command,file]=argv;
 if(command==='hold'){process.stdout.write(holdSql());return 0;}
 if(command==='release'){process.stdout.write(releaseSql());return 0;}
 if(!['import','activate','digest'].includes(command)||!file){process.stderr.write('usage: started-d1-sql.mjs hold|release | import|activate|digest <started-export.json>\n');return 1;}
 let marks;
 try{marks=readSource(file);}catch(error){process.stderr.write('BLOCKER: '+error.message+'\n');return 2;}
 try{
  if(command==='digest')process.stdout.write(JSON.stringify(digestOf(marks))+'\n');
  else process.stdout.write(command==='import'?importSql(marks):activateSql(marks));
 }catch(error){if(!error.blocker)throw error;process.stderr.write('BLOCKER: '+error.message+'\n');return 2;}
 return 0;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)process.exitCode=main(process.argv.slice(2));
