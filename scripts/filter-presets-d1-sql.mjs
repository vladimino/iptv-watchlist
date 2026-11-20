// Offline SQL generator for the Filter presets R2 -> D1 cutover (schema v28). It reads a LOCAL export of the R2 object
// `ui/filter-presets.json` and prints guarded SQL to stdout. It opens no database, no bucket and no network connection, and it applies
// nothing: the operator applies the printed SQL only under an owner GO (docs/runbooks/filter-presets-cutover.md).
//
//   node scripts/filter-presets-d1-sql.mjs hold
//   node scripts/filter-presets-d1-sql.mjs import   <r2-export.json>
//   node scripts/filter-presets-d1-sql.mjs activate <r2-export.json>
//   node scripts/filter-presets-d1-sql.mjs release
//   node scripts/filter-presets-d1-sql.mjs digest   <r2-export.json>
//
// A document the Worker itself cannot read (not an object, no presets array, more than 30, one unreadable record) is a blocker: the
// script exits 2 and prints no SQL. It never turns a broken source into an empty import. The presets are written as the Worker serves
// them (normalized), so served-document parity is what is compared.
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const PRESET_COLUMNS=['id','name','query','createdAt','updatedAt'];
const sql=value=>"'"+String(value).replace(/'/g,"''")+"'";
export function readSource(file){
 let data;
 try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Object.assign(new Error('the export is not readable JSON'),{blocker:true});}
 const context=vm.createContext({URL,URLSearchParams,Date,JSON,Set,Object,Array,String,Number,crypto:crypto.webcrypto});
 vm.runInContext(fs.readFileSync('src/filter-presets.js','utf8')+'\nglobalThis.inspect=inspectPresetDocument;',context);
 const inspected=context.inspect(data);
 if(inspected.error)throw Object.assign(new Error('the export is not a readable preset document: '+inspected.error),{blocker:true});
 return JSON.parse(JSON.stringify(inspected.presets));
}
export function digestOf(presets){return crypto.createHash('sha256').update(JSON.stringify(presets.map(item=>PRESET_COLUMNS.map(key=>item[key])))).digest('hex');}
export function holdSql(){
 return "UPDATE filter_preset_authority SET writes='held' WHERE id=1 AND mode='r2' AND writes='open' AND generation=0;\nUPDATE filter_preset_cas SET ok=changes() WHERE id=1;\n";
}
export function releaseSql(){
 return "UPDATE filter_preset_authority SET writes='open' WHERE id=1 AND mode='r2' AND writes='held' AND generation IN (0,1);\nUPDATE filter_preset_cas SET ok=changes() WHERE id=1;\n";
}
export function importSql(presets){
 const lines=[
  "UPDATE filter_preset_authority SET generation=1 WHERE id=1 AND mode='r2' AND writes='held' AND generation=0 AND (SELECT COUNT(*) FROM filter_preset)=0;",
  'UPDATE filter_preset_cas SET ok=changes() WHERE id=1;',
 ];
 presets.forEach((item,index)=>lines.push('INSERT INTO filter_preset (id,position,name,query,created_at,updated_at,generation) VALUES ('+[sql(item.id),index,sql(item.name),sql(item.query),sql(item.createdAt),sql(item.updatedAt),1].join(',')+');'));
 return lines.join('\n')+'\n';
}
// D1 refuses a SQL statement over 100,000 bytes, and a valid document (30 presets of about 4,000 characters) is larger than that. So parity is checked
// by one short statement per preset (each aborts the file when its row differs, through the fence row's CHECK) and the activation itself is one short
// guarded statement. Every statement is on its own line and holds one preset at most.
export function activateSql(presets){
 const lines=[];
 presets.forEach((item,index)=>lines.push('UPDATE filter_preset_cas SET ok=(SELECT COUNT(*) FROM filter_preset WHERE position='+index+' AND id='+sql(item.id)+' AND name='+sql(item.name)+' AND query='+sql(item.query)+' AND created_at='+sql(item.createdAt)+' AND updated_at='+sql(item.updatedAt)+' AND generation=1) WHERE id=1;'));
 lines.push("UPDATE filter_preset_authority SET mode='d1', writes='open' WHERE id=1 AND mode='r2' AND writes='held' AND generation=1 AND (SELECT COUNT(*) FROM filter_preset)="+presets.length+';');
 lines.push('UPDATE filter_preset_cas SET ok=changes() WHERE id=1;');
 return lines.join('\n')+'\n';
}
function main(argv){
 const [command,file]=argv;
 if(command==='hold'){process.stdout.write(holdSql());return 0;}
 if(command==='release'){process.stdout.write(releaseSql());return 0;}
 if(!['import','activate','digest'].includes(command)||!file){process.stderr.write('usage: filter-presets-d1-sql.mjs hold|release | import|activate|digest <r2-export.json>\n');return 1;}
 let presets;
 try{presets=readSource(file);}catch(error){process.stderr.write('BLOCKER: '+error.message+'\n');return 2;}
 if(command==='digest')process.stdout.write(JSON.stringify({count:presets.length,sha256:digestOf(presets)})+'\n');
 else process.stdout.write(command==='import'?importSql(presets):activateSql(presets));
 return 0;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href)process.exitCode=main(process.argv.slice(2));
