// AIR-374 S4-2 (ADR 0128, stage S4-2): migration 0020, the durable canonical producer run and unit result tables (migrations/0020_canonical_producer_run.sql), OFFLINE. sqlite3-CLI D1 stand-in only: no Worker, R2, D1 or
// Cloudflare access; nothing here applies anything to production. Covered: the migration on top of a complete schema 19 (and its refusal on anything else), the marker fence (both tables are writable only at d1/open), every CHECK of
// the result row against the pure module's own `assertResultRow` (a DIFFERENTIAL over every column and every state, with the exact set of known differences pinned), the run row (origin blocks, strike columns, the generation
// claim against `canonicalFreshness`), the strike triggers against `strikeViolation` (a differential over a strike universe and all six causes), the replay move, the compare-and-set revision, the dictionary mint guard
// (scenario B of the ADR), the result state machine and scenario A, the live-row unique index, append-only, and the rows the pure functions themselves produce (third strike, plan change, refusals, retry decisions)
// accepted by the SQL. CANON_PRODUCER_MIGRATION points the file at a mutant of the migration (tests/canonical-producer-schema-mutation.mjs); CANON_PRODUCER_TEMPLATE19 is a prebuilt schema 19 database that runner shares.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import * as R from '../src/canonical-producer-run.js';

const only=process.env.CANON_PRODUCER_ONLY?new Set(process.env.CANON_PRODUCER_ONLY.split(',')):null;
const on=number=>!only||only.has(String(number));
const MIGRATION=process.env.CANON_PRODUCER_MIGRATION||'migrations/0020_canonical_producer_run.sql';
const text20=fs.readFileSync(MIGRATION,'utf8');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const upTo19=chain.filter(name=>Number(name.slice(0,4))<=19);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-producer-schema-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const bail=(file,input)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,input)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,input)=>Object.values(rows(file,input)[0]||{})[0];
const message=result=>String(result.stderr||'');

// ---- databases: schema 19 once (shared by the mutation runner), 0020 applied on a copy, the marker at d1/open on a copy of that ----
const t19=path.join(root,'t19.sqlite'),t20=path.join(root,'t20.sqlite'),open=path.join(root,'open.sqlite');
if(process.env.CANON_PRODUCER_TEMPLATE19)fs.copyFileSync(process.env.CANON_PRODUCER_TEMPLATE19,t19);
else assert.equal(bail(t19,upTo19.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
fs.copyFileSync(t19,t20);
assert.equal(bail(t20,text20).status,0,'0020 applies on a complete schema 19');
fs.copyFileSync(t20,open);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
assert.equal(bail(open,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;").status,0);
let n=0;
const copyOf=source=>{const file=path.join(root,'db-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};

const H=char=>char.repeat(64);
const AT='2026-11-12T10:00:00.000Z';
const q=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const insert=(table,row)=>{const keys=Object.keys(row);return `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(key=>q(row[key])).join(',')})`;};
const RUN='canonical_producer_run',RES='canonical_producer_unit_result';
const epgRun=(over={})=>({origin:'epg',run_key:'epg:r1',source_generation:'g1',plan_version:1,fingerprint:H('a'),unit_count:3,pass_state:'passing',marker_generation:2,created_at:AT,updated_at:AT,...over});
const dictRun=(seq,digest,over={})=>({origin:'dictionary',run_key:'d'+seq,seq,prev_seq:seq-1,snapshot_digest:digest,plan_version:1,fingerprint:H('a'),unit_count:3,pass_state:'passing',marker_generation:2,created_at:AT,updated_at:AT,...over});
const RESULT_COLUMNS=['origin','run_key','pass_no','kind','unit_id','fingerprint','unit_digest','state','retry_owner','request_id','code','attempts','prereq_stamp','next_attempt_at','settled_by','created_at','updated_at','settled_at'];
const resultInsert=row=>insert(RES,Object.fromEntries(RESULT_COLUMNS.map(column=>[column,row[column]])));
const keyWhere=row=>`origin=${q(row.origin)} AND run_key=${q(row.run_key)} AND pass_no=${row.pass_no} AND kind=${q(row.kind)} AND unit_id=${q(row.unit_id)}`;
const patchSql=(row,patch)=>`UPDATE ${RES} SET ${Object.entries(patch).map(([key,value])=>key+'='+q(value)).join(',')} WHERE ${keyWhere(row)}`;
const runUpdate=(patch,key='epg:r1',origin='epg')=>`UPDATE ${RUN} SET ${Object.entries(patch).map(([k,v])=>k+'='+q(v)).join(',')},revision=revision+1 WHERE origin=${q(origin)} AND run_key=${q(key)}`;
const seedRuns=file=>assert.equal(bail(file,[insert(RUN,epgRun()),insert(RUN,dictRun(1,H('b')))].join(';\n')).status,0);
const fresh=(source=open)=>{const file=copyOf(source);seedRuns(file);return file;};

// Run many cases against one database without any of them persisting: every statement is its OWN line, inside a savepoint that is rolled back, and the shell runs without -bail, so the line number of an error names the case.
// Returns, per case, the list of error messages (empty: the whole case was accepted).
function probe(file,cases){
 const lines=[],owner=[];
 cases.forEach((statements,index)=>{for(const statement of ['SAVEPOINT p',...[].concat(statements),'ROLLBACK TO p','RELEASE p']){assert.ok(!statement.includes('\n'));lines.push(statement+';');owner.push(index);}});
 const out=spawnSync('sqlite3',[file],{input:'PRAGMA foreign_keys=ON;\n'+lines.join('\n')+'\n',encoding:'utf8',maxBuffer:1<<26});
 const errors=cases.map(()=>[]);
 // an error message (a CHECK with its text) may continue on the following lines
 let last=null;
 for(const line of out.stderr.split('\n')){const match=/near line (\d+): (.*)$/.exec(line);if(match){last=errors[owner[Number(match[1])-2]];last.push(match[2]);}else if(line.trim()&&last)last[last.length-1]+=' '+line.trim();else if(line.trim())throw new Error('unparsed sqlite3 stderr: '+line);}
 return errors;
}
const accepted=(file,statements)=>probe(file,[statements])[0].length===0;
const refusedWith=(file,statements,pattern,label)=>{const [errors]=probe(file,[statements]);assert.ok(errors.length>0,'refused: '+label);assert.ok(errors.some(error=>pattern.test(error)),label+': '+errors.join(' | ')+' should match '+pattern);};

// ===== 1. The migration: on top of a complete schema 19, empty, version 20, the exact object set, refusals, no downgrade =====
if(on(1)){
 assert.deepEqual(chain.slice(-2),['0020_canonical_producer_run.sql','0021_d1_glob_pattern_limit.sql'],'0020 is followed only by 0021, the D1 pattern-limit rebuild (tests/migration-pattern-limit.mjs)');
 assert.equal(Number(one(t20,'SELECT version FROM schema_contract WHERE id=1')),20);
 assert.equal(one(t20,'SELECT note FROM schema_contract WHERE id=1'),'Schema v20: durable canonical producer run and unit result tables (empty). Follows a complete version 19.');
 for(const table of [RUN,RES])assert.equal(Number(one(t20,'SELECT COUNT(*) FROM '+table)),0,table+' starts empty');
 const objects=type=>rows(t20,`SELECT name FROM sqlite_master WHERE type='${type}' AND name GLOB 'canonical_producer_*' ORDER BY name`).map(row=>row.name);
 assert.deepEqual(objects('table'),[RUN,RES]);
 assert.equal(objects('index').length,7);
 assert.equal(objects('trigger').length,22);
 assert.equal(Number(one(t20,"SELECT COUNT(*) FROM sqlite_master WHERE name GLOB 'canonical_producer_*'")),31);
 assert.ok(rows(t20,"SELECT sql FROM sqlite_master WHERE type='table' AND name GLOB 'canonical_producer_*'").every(row=>/\) STRICT$/.test(row.sql)),'both tables are STRICT');
 // exactly the columns the pure module's row shapes need, in order (no payload column)
 assert.deepEqual(rows(t20,`SELECT name FROM pragma_table_info('${RES}')`).map(row=>row.name),RESULT_COLUMNS);
 assert.deepEqual(rows(t20,`SELECT name FROM pragma_table_info('${RUN}')`).map(row=>row.name),['origin','run_key','seq','prev_seq','snapshot_digest','source_generation','applied_generation','pass_no','plan_version','fingerprint','unit_count','cursor_kind','cursor_id','pass_state','stopped_by','strike_kind','strike_id','strike_digest','strike_class','strike_count','n_applied','n_noop','n_kept','n_failed','open_at_completion','marker_generation','revision','created_at','updated_at','completed_at']);
 // the migration writes no data row and moves no marker (the chain's own marker row is what it was)
 assert.deepEqual(rows(t20,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}]);
 // refuses anything but a complete schema 19, before a table is created
 const refuse=(file,label,existing=0)=>{const r=bail(file,text20);assert.notEqual(r.status,0,label);assert.equal(Number(one(file,"SELECT COUNT(*) FROM sqlite_master WHERE name GLOB 'canonical_producer_*'")),existing,label+': nothing was created');};
 const v18=copyOf(t19);assert.equal(bail(v18,"DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=18 WHERE id=1").status,0);
 refuse(v18,'a version 18 stamp');
 const v17=copyOf(t19);assert.equal(bail(v17,"DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=17 WHERE id=1").status,0);
 refuse(v17,'a version 17 stamp');
 for(const table of ['canonical_write_receipt','canonical_receipt_baseline','canonical_receipt_watermark','canonical_receipt_baseline_seal']){
  const missing=copyOf(t19);assert.equal(bail(missing,'DROP TABLE '+table).status,0);
  refuse(missing,'a version 19 missing '+table);
 }
 const noMarker=copyOf(t19);assert.equal(bail(noMarker,'DROP TABLE film_person_cas').status,0);refuse(noMarker,'a version 19 missing film_person_cas');
 refuse(t20,'a second apply',31);
 assert.match(message(bail(t20,'UPDATE schema_contract SET version=19 WHERE id=1')),/schema_contract_downgrade/,'the version never goes down');
 assert.ok(fs.readFileSync('migrations/README.md','utf8').includes('0020_canonical_producer_run.sql'),'migrations/README.md lists 0020');
}

// ===== 2. The marker fence: both tables are writable only at d1/open; reads always =====
if(on(2)){
 for(const [stage,statements] of [['r2',''],['prepared',VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"]]){
  const file=copyOf(t20);if(statements)assert.equal(bail(file,statements).status,0);
  const generation=stage==='r2'?0:1;
  refusedWith(file,insert(RUN,epgRun({marker_generation:generation})),/canonical_producer_not_open/,stage+': a run insert');
  assert.equal(Number(one(file,'SELECT COUNT(*) FROM '+RUN)),0,stage+': stays empty');
 }
 // at d1/open rows are written; then held freezes both tables (insert and update), and a read still works
 const file=fresh();
 const result=R.resultRow({origin:'epg',runKey:'epg:r1',passNo:1,fingerprint:H('a'),unit:{kind:'film_facts',id:'film:tmdb:1',digest:H('b')},state:'refused_permanent',code:'film_person_bounded',at:AT});
 assert.equal(bail(file,resultInsert(result)).status,0);
 assert.equal(bail(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 refusedWith(file,insert(RUN,epgRun({run_key:'epg:r2',marker_generation:3})),/canonical_producer_not_open/,'held: run insert');
 refusedWith(file,runUpdate({updated_at:AT}),/canonical_producer_not_open/,'held: run update');
 refusedWith(file,resultInsert({...result,unit_id:'film:tmdb:2'}),/canonical_producer_not_open/,'held: result insert');
 refusedWith(file,patchSql(result,{updated_at:AT}),/canonical_producer_not_open/,'held: result update');
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM '+RES)),1,'a read works while held');
 // the prepared and r2 markers also refuse the result table
 const prepared=copyOf(t20);assert.equal(bail(prepared,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;").status,0);
 refusedWith(prepared,resultInsert(result),/canonical_producer_not_open/,'prepared: result insert (the parent check is after the fence)');
}

// ===== 3. The result row: every CHECK against assertResultRow (a differential), and the pinned differences =====
const BADTIME='2026-11-12T10:00:00.000?Z',LONGTIME='2026-11-12T10:00:00.0000000000000000Z',ZONETIME='2026-11-12T10:00:00.000+01:00';
const unitOf=id=>({kind:'film_facts',id,digest:H('b')});
const base=(state,code,extra={})=>R.resultRow({origin:'epg',runKey:'epg:r1',passNo:1,fingerprint:H('a'),unit:unitOf('film:tmdb:1'),state,code,at:AT,...extra});
const BASES={
 open_unit:base('open','identity_collision',{attempts:3}),
 open_receipt:base('open','write_failed',{retryOwner:'receipt',requestId:'epg:r1:req1'}),
 permanent:base('refused_permanent','film_person_bounded'),
 recoverable:base('refused_recoverable','no_identity_row',{prereqStamp:H('e')}),
};
if(on(3)){
 for(const row of Object.values(BASES))R.assertResultRow(row);
 const VALUES={
  origin:[null,'','x','dictionary'],run_key:[null,'','x'.repeat(160),'x'.repeat(161)],pass_no:[null,0,-1,1.5,10000,10001,'a'],kind:[null,'','Kind','a1','x'.repeat(41),'a_b','x'.repeat(40)],unit_id:[null,'','x'.repeat(200),'x'.repeat(201)],
  fingerprint:[null,'',H('A'),'a'.repeat(63),'a'.repeat(65),H('g'),H('0')],unit_digest:[null,'a'.repeat(63),H('Z')],state:['open','refused_permanent','refused_recoverable','settled','superseded','abandoned','nope','other',null],
  retry_owner:['unit','receipt','x','other',null],request_id:[null,'','r','a b','x'.repeat(201),'x'.repeat(200)],
  code:[null,'','Abc','1abc','a b','a'.repeat(80),'a'.repeat(81),'film_person_bounded','no_identity_row','identity_collision','unclassified','film_person_unavailable','owner_kept','write_failed'],
  attempts:[null,0,1,16,17,-1,1.5],prereq_stamp:[null,H('f'),'abc',H('F')],next_attempt_at:[null,AT,'x','2026-11-12 10:00:00',BADTIME,LONGTIME,ZONETIME],settled_by:[null,'applied','Bad'],created_at:[null,'x',BADTIME,LONGTIME,ZONETIME],updated_at:[null,'x',BADTIME,LONGTIME,ZONETIME],settled_at:[null,AT,'x',BADTIME,LONGTIME,ZONETIME],
 };
 // every case: [base name, column, value, pure verdict (assertResultRow does not throw), SQL verdict]. The run row of the keys exists, so a key mutation is only judged against the key shape rules, not the parent.
 const cases=[];
 for(const [name,row] of Object.entries(BASES))for(const column of RESULT_COLUMNS)for(const value of VALUES[column]){
  const mutated={...row,[column]:value};
  let pure=true;try{R.assertResultRow(mutated);}catch{pure=false;}
  cases.push({name,column,value,pure,statement:resultInsert(mutated)});
 }
 const file=fresh();
 const errors=probe(file,cases.map(item=>item.statement));
 const differences=new Map();
 cases.forEach((item,index)=>{
  const sqlOk=errors[index].length===0;
  if(sqlOk===item.pure)return;
  const text=errors[index].join(' | ');
  let reason;
  if(item.column==='origin'||item.column==='run_key'){reason='parent_run_required';assert.ok(!sqlOk&&/FOREIGN KEY/.test(text),'a key that names no run is the foreign key');}
  else if((item.column==='code'&&/^[a-z][a-z_0-9]{0,79}$/.test(item.value))||(item.column==='state'&&R.RESULT_STATES.includes(item.value))){reason='code_class_not_in_sql';assert.ok(sqlOk&&!item.pure,'the class of a code against the state is judged by the pure module only: '+item.name+' '+item.column+' '+item.value);}
  else if(['created_at','updated_at','next_attempt_at','settled_at'].includes(item.column)){reason='time_shape';assert.ok(!sqlOk&&item.pure,'SQL is stricter on a time: '+item.column+' '+item.value);}
  else if(item.column==='request_id'){reason='request_id_shape';assert.ok(!sqlOk&&item.pure);}
  else if(item.column==='settled_by'){reason='settled_by_shape';assert.ok(!sqlOk&&item.pure);}
  else throw new Error('an UNEXPECTED difference between assertResultRow and the SQL: '+JSON.stringify({name:item.name,column:item.column,value:item.value,pure:item.pure,sqlOk,text}));
  differences.set(reason,(differences.get(reason)||0)+1);
 });
 assert.deepEqual([...differences.keys()].sort(),['code_class_not_in_sql','parent_run_required','request_id_shape','settled_by_shape','time_shape'],'the known differences, all observed, none other');
 // the cases that DO agree are many: the row shape rules are the same on both sides
 assert.ok(cases.length-[...differences.values()].reduce((a,b)=>a+b,0)>=250,'the agreeing cases');
 // a code of the class table, by class, state and owner: SQL accepts every shape-valid code (class is the module's job) and pure refuses the wrong class; each code of the table is a valid SQL code
 const classes=Object.entries(R.ERROR_CLASSES);
 const codeCases=[];
 for(const [code,cls] of classes)for(const [state,mutation] of [['open',BASES.open_unit],['refused_permanent',BASES.permanent],['refused_recoverable',BASES.recoverable]]){
  const row={...mutation,code};let pure=true;try{R.assertResultRow(row);}catch{pure=false;}
  codeCases.push({code,cls,state,pure,statement:resultInsert(row)});
 }
 const codeErrors=probe(file,codeCases.map(item=>item.statement));
 assert.ok(codeErrors.every(list=>list.length===0),'every code of the table fits the SQL code shape');
 const pureOk=codeCases.filter(item=>item.pure).map(item=>item.state+':'+item.cls).sort();
 assert.deepEqual([...new Set(pureOk)].sort(),['open:unit_specific','refused_permanent:refused_permanent','refused_recoverable:refused_recoverable'],'the pure module accepts exactly the matching class');
 assert.ok(codeCases.filter(item=>!item.pure).length>30,'the SQL accepts rows the pure module refuses (the class), as documented');
 // The SQL vocabulary of the columns the pure module only tests for presence, judged by the SQL alone (these are the differences above, pinned value by value): times, request ids, codes, settled_by
 const vocab=(base,column,good,bad,label)=>{
  const cases=[...good.map(value=>({value,want:true})),...bad.map(value=>({value,want:false}))];
  const out=probe(file,cases.map(item=>resultInsert({...base,[column]:item.value})));
  cases.forEach((item,index)=>assert.equal(out[index].length===0,item.want,label+' '+JSON.stringify(item.value)+' '+out[index].join('|')));
 };
 const GOOD_TIME=[AT,'2026-11-12T10:00:00Z','2026-11-12T10:00:00.123456Z'],BAD_TIME=[BADTIME,LONGTIME,ZONETIME,'x','2026-11-12 10:00:00','2026-11-12T10:00:00.000','2026-11-12T10:00:00.000z','2026-11-12T10:00:00.000 Z','20261112T100000.000Z'];
 vocab(BASES.open_unit,'created_at',GOOD_TIME,BAD_TIME,'created_at');
 vocab(BASES.open_unit,'updated_at',GOOD_TIME,BAD_TIME,'updated_at');
 vocab(BASES.open_unit,'next_attempt_at',GOOD_TIME,BAD_TIME,'next_attempt_at');
 vocab(BASES.open_receipt,'request_id',['epg:r1:req1','a','A.b-c_d/e=f+g@h:1','x'.repeat(200)],['','a b','x'.repeat(201),'a;b','a\\b','a#b','a%b'],'request_id');
 vocab(BASES.open_unit,'code',['a','a1','a_b','a'.repeat(80),'identity_collision'],['','A','1a','_a','a-b','a b','a'.repeat(81),'a.b','Ab'],'code');
 vocab(BASES.open_unit,'kind',['a','film_facts','a_b','x'.repeat(40)],['','A','a1','a-b','x'.repeat(41),'a b'],'kind');
 vocab(BASES.open_unit,'unit_digest',[H('a'),H('0'),'0123456789abcdef'.repeat(4)],['',H('A'),'a'.repeat(63),'a'.repeat(65),'g'.repeat(64),'a'.repeat(63)+'-'],'unit_digest');
 vocab(BASES.open_unit,'fingerprint',[H('a')],['',H('A'),'a'.repeat(63),'g'.repeat(64)],'fingerprint');
 vocab(BASES.recoverable,'prereq_stamp',[H('e')],[H('E'),'a'.repeat(63),'g'.repeat(64)],'prereq_stamp');
 vocab(BASES.open_unit,'unit_id',['a','film:tmdb:1','x'.repeat(200)],['','x'.repeat(201)],'unit_id');
 vocab(BASES.open_unit,'attempts',[1,3,16],[0,17,-1],'attempts');
 vocab(BASES.open_unit,'pass_no',[1,10000],[0,10001,-1],'pass_no');
 {
  // the state vocabulary on a copy without the birth-shape trigger, so the CHECK is judged alone
  const stateFile=fresh();assert.equal(bail(stateFile,'DROP TRIGGER canonical_producer_unit_result_insert_shape').status,0);
  const states=['other','OPEN','',' open'];
  const out=probe(stateFile,states.map(state=>resultInsert({...BASES.open_unit,state})));
  out.forEach((list,index)=>assert.ok(list.length>0,'state '+JSON.stringify(states[index])+' refused'));
 }
 vocab(BASES.open_unit,'retry_owner',['unit'],['other','Unit'],'retry_owner');
 // settled_by is judged on the move to a terminal state
 {
  const live=BASES.open_unit,run=fresh();assert.equal(bail(run,resultInsert(live)).status,0);
  const moves=[...['applied','source_changed','a','a_b1','x'.repeat(64)].map(value=>({value,want:true})),...['','A','1a','a-b','a b','x'.repeat(65)].map(value=>({value,want:false}))];
  const out=probe(run,moves.map(item=>patchSql(live,{state:'settled',settled_at:AT,settled_by:item.value,next_attempt_at:null})));
  moves.forEach((item,index)=>assert.equal(out[index].length===0,item.want,'settled_by '+JSON.stringify(item.value)+' '+out[index].join('|')));
  const terminal=probe(run,['settled','superseded','abandoned'].map(state=>patchSql(live,{state,settled_at:AT,settled_by:'x',next_attempt_at:null})));
  assert.ok(terminal.every(list=>list.length===0),'each terminal state');
  const timeOut=probe(run,[...GOOD_TIME.map(value=>({value,want:true})),...BAD_TIME.map(value=>({value,want:false}))].map(item=>patchSql(live,{state:'settled',settled_at:item.value,settled_by:'x',next_attempt_at:null})));
  timeOut.forEach((list,index)=>assert.equal(list.length===0,index<GOOD_TIME.length,'settled_at '+index+' '+list.join('|')));
 }
}

// ===== 4. The unique live row, the foreign key, the terminal states by move, and the pure functions' own rows =====
if(on(4)){
 const file=fresh();
 const a=BASES.permanent;
 assert.equal(bail(file,resultInsert(a)).status,0);
 // a second LIVE row of the same unit and run (another pass_no) is refused; a different unit, or the other run, is fine
 refusedWith(file,resultInsert({...a,pass_no:2}),/UNIQUE constraint failed/,'a second live row of the unit');
 assert.ok(accepted(file,resultInsert({...a,unit_id:'film:tmdb:2'})));
 // one live row per unit across the THREE live states: a second row of any live state for the same unit and run is refused (another pass_no), whatever its state
 {
  const second=[{...BASES.open_unit,unit_id:'film:tmdb:1',pass_no:2},{...BASES.recoverable,unit_id:'film:tmdb:1',pass_no:2},{...BASES.permanent,unit_id:'film:tmdb:1',pass_no:3},{...BASES.open_receipt,unit_id:'film:tmdb:1',pass_no:2}];
  for(const row of second)refusedWith(file,resultInsert(row),/UNIQUE constraint failed/,'a second live row ('+row.state+') of a live unit');
 }
 // the keys: the pass_no is part of the primary key (the same unit under another pass is another row once the first is terminal), and the lookups use their indexes
 {
  const plan=sql=>{const r=bail(file,'EXPLAIN QUERY PLAN '+sql);assert.equal(r.status,0,message(r));return String(r.stdout).replace(/\s+/g,' ');};
  // the partial index is USABLE for the due read the retry pass makes (INDEXED BY fails with "no query solution" when it is not); which index the planner prefers on an empty table is its own cost choice
  assert.match(plan("SELECT * FROM canonical_producer_unit_result INDEXED BY canonical_producer_unit_result_due WHERE state IN ('open', 'refused_recoverable') AND retry_owner = 'unit' AND next_attempt_at <= '2026-11-12T10:00:00.000Z' ORDER BY next_attempt_at LIMIT 25"),/canonical_producer_unit_result_due \(next_attempt_at</,'the due read can use the partial index');
  assert.match(plan("SELECT * FROM canonical_producer_unit_result WHERE origin='epg' AND kind='film_facts' AND unit_id='film:tmdb:1' AND state='open'"),/canonical_producer_unit_result_(unit|live)/,'the per-unit lookup uses an index');
  assert.match(plan("SELECT * FROM canonical_producer_unit_result WHERE state='refused_permanent' AND code='film_person_bounded'"),/canonical_producer_unit_result_state/,'the read-model count by state and code uses its index');
  assert.match(plan("SELECT * FROM canonical_producer_run WHERE origin='dictionary' AND seq=3"),/canonical_producer_run_seq/,'the latest dictionary row is read by seq');
  assert.match(plan("SELECT * FROM canonical_producer_run WHERE origin='epg' AND source_generation='g1' AND applied_generation='g1'"),/canonical_producer_run_fresh/,'the freshness read uses its index');
  assert.equal(rows(file,"SELECT name FROM pragma_table_info('canonical_producer_unit_result') WHERE pk>0 ORDER BY pk").map(row=>row.name).join(','),'origin,run_key,pass_no,kind,unit_id');
 }
 refusedWith(file,resultInsert({...a,run_key:'epg:nope'}),/FOREIGN KEY/,'no run row');
 refusedWith(file,resultInsert({...a,state:'settled',settled_at:AT,settled_by:'applied'}),/canonical_producer_result_insert/,'a terminal row is never inserted');
 // Scenario A (ADR 0128): pass 1 row superseded `source_changed`, then the pass-2 row of the same unit is inserted; the pass-1 row stays, terminal
 const failing=base('open','identity_collision',{attempts:3});
 assert.equal(bail(file,resultInsert(failing).replace('film:tmdb:1','film:tmdb:9')).status,0);
 const live={...failing,unit_id:'film:tmdb:9'};
 const incoming={origin:'epg',runKey:'epg:r1',passNo:2,fingerprint:H('d'),unit:{kind:'film_facts',id:'film:tmdb:9',digest:H('c')},state:'open',code:'identity_collision',at:'2026-11-12T10:05:00.000Z'};
 const write=R.failureWrite(live,incoming);
 assert.ok(write.supersede&&write.insert,'scenario A: supersede then insert');
 assert.equal(write.supersede.patch.state,'superseded');
 // the insert before the supersede is refused by the live unique index (the order of the slice batch matters)
 refusedWith(file,resultInsert(write.insert),/UNIQUE constraint failed/,'insert before supersede');
 assert.ok(accepted(file,[patchSql(live,write.supersede.patch),resultInsert(write.insert)]));
 assert.equal(bail(file,runUpdate({pass_no:2,fingerprint:H('d'),cursor_kind:null,cursor_id:null,strike_count:0,pass_state:'passing'})+';\n'+patchSql(live,write.supersede.patch)+';\n'+resultInsert(write.insert)).status,0);
 assert.deepEqual(rows(file,`SELECT pass_no,state,settled_by FROM ${RES} WHERE unit_id='film:tmdb:9' ORDER BY pass_no`),[{pass_no:1,state:'superseded',settled_by:'source_changed'},{pass_no:2,state:'open',settled_by:null}],'both rows are durable under different keys');
 // a terminal row never moves again, not even by an update that changes nothing
 refusedWith(file,patchSql(live,{updated_at:AT}),/canonical_producer_result_terminal/,'a terminal row is frozen');
 refusedWith(file,patchSql(live,{state:'open',settled_at:null,settled_by:null,next_attempt_at:AT}),/canonical_producer_result_terminal/,'never reopens');
 // the same digest: the live row keeps its key and takes the new classification (attempts + 1 for an execution failure)
 const same=R.failureWrite(write.insert,{...incoming,at:'2026-11-12T10:06:00.000Z'});
 assert.ok(same.update);
 assert.ok(accepted(file,patchSql(write.insert,same.update.patch)));
}
{
 // Every patch and row the pure decisions produce is accepted by the SQL, in order, on one run (the lifecycle of the three kinds of result)
 const file=fresh();
 const NOW=Date.parse('2026-11-12T10:00:00.000Z');
 const at=ms=>new Date(NOW+ms).toISOString();
 const apply=(row,patch)=>{assert.equal(bail(file,patchSql(row,patch)).status,0,'SQL accepts the patch '+JSON.stringify(patch));return {...row,...patch};};
 // an execution failure: open, unit owner; retried (attempts + 1) and abandoned by the receipt policy
 let open=base('open','identity_collision',{attempts:3});assert.equal(bail(file,resultInsert(open)).status,0);
 const again=R.afterRetry(open,{kind:'failed',error:{code:'identity_collision'}},{nowMs:NOW+300000});
 assert.equal(again.action,'update');open=apply(open,again.patch);assert.equal(open.attempts,4);
 const old=R.retryDecision({...open,attempts:5},{nowMs:NOW+3600000,currentUnitDigest:open.unit_digest,trigger:'due'});
 assert.equal(old.action,'abandon');open=apply(open,old.patch);assert.equal(open.state,'abandoned');
 // a recoverable refusal: deferred (an unchanged stamp), reclassified permanent, then superseded
 let recoverable=base('refused_recoverable','no_identity_row',{prereqStamp:H('e'),unit:unitOf('film:tmdb:2')});assert.equal(bail(file,resultInsert(recoverable)).status,0);
 const deferred=R.retryDecision(recoverable,{nowMs:NOW+3600000,currentUnitDigest:recoverable.unit_digest,currentStamp:H('e'),trigger:'due'});
 assert.equal(deferred.action,'defer');recoverable=apply(recoverable,deferred.patch);
 const to_permanent=R.afterRetry(recoverable,{kind:'refused',error:{code:'film_person_invalid'}},{nowMs:NOW+7200000});
 recoverable=apply(recoverable,to_permanent.patch);assert.equal(recoverable.state,'refused_permanent');assert.equal(recoverable.prereq_stamp,null);
 const gone=R.retryDecision(recoverable,{nowMs:NOW+7300000,currentUnitDigest:null,trigger:'reobserved'});
 recoverable=apply(recoverable,gone.patch);assert.deepEqual([recoverable.state,recoverable.settled_by],['superseded','left_plan']);
 // a recoverable refusal that is resolved: settled only after the write's proof (the patch of the proof)
 let resolved=base('refused_recoverable','needs_trusted_tmdb_id',{prereqStamp:H('e'),unit:unitOf('film:tmdb:3')});assert.equal(bail(file,resultInsert(resolved)).status,0);
 const proof=R.afterRetry(resolved,{kind:'proof',proof:'applied_receipt'},{nowMs:NOW+4000000});
 resolved=apply(resolved,proof.patch);assert.deepEqual([resolved.state,resolved.settled_by],['settled','prerequisite_resolved']);
 // a receipt-owned row: carries the request id, no schedule, and is settled by its owner (a move to settled keeps the owner)
 let receipt=base('open','write_failed',{retryOwner:'receipt',requestId:'epg:r1:req9',unit:unitOf('film:tmdb:4'),attempts:2});assert.equal(bail(file,resultInsert(receipt)).status,0);
 receipt=apply(receipt,{state:'settled',settled_at:at(5000000),settled_by:'applied',updated_at:at(5000000)});
 // a recoverable row recreated by the third strike path: the result the strike machine produces is accepted as an insert
 const thirdRun={cursor_kind:null,cursor_id:null,pass_no:1,pass_state:'passing',stopped_by:null,...R.NO_STRIKE};
 let step=R.strikeStep(thirdRun,{type:'unit_failed',unit:{kind:'film_facts',id:'film:tmdb:5',digest:H('b')},error:{code:'credit_ordinal_conflict'}});
 assert.equal(step.action,'strike');
 step=R.strikeStep(step.run,{type:'unit_failed',unit:{kind:'film_facts',id:'film:tmdb:5',digest:H('b')},error:{code:'credit_ordinal_conflict'}});
 const strikeRun=step.run;
 step=R.strikeStep(strikeRun,{type:'unit_failed',unit:{kind:'film_facts',id:'film:tmdb:5',digest:H('b')},error:{code:'credit_ordinal_conflict'}});
 assert.equal(step.action,'third_strike');
 const third=R.resultRow({origin:'epg',runKey:'epg:r1',passNo:1,fingerprint:H('a'),unit:unitOf('film:tmdb:5'),state:step.result.state,code:step.result.code,attempts:step.result.attempts,at:AT});
 // the three batches of the strike machine, in order, each ONE update of the run row with the previous row as its start
 const strikes=R.strikeStep(thirdRun,{type:'unit_failed',unit:{kind:'film_facts',id:'film:tmdb:5',digest:H('b')},error:{code:'credit_ordinal_conflict'}}).run;
 const strike=run=>({strike_kind:run.strike_kind,strike_id:run.strike_id,strike_digest:run.strike_digest,strike_class:run.strike_class,strike_count:run.strike_count});
 assert.equal(bail(file,runUpdate(strike(strikes))).status,0);
 assert.equal(bail(file,runUpdate(strike(strikeRun))).status,0);
 assert.equal(bail(file,[runUpdate({...strike(step.run),cursor_kind:step.run.cursor_kind,cursor_id:step.run.cursor_id}),resultInsert(third)].join(';\n')).status,0,'the third-strike batch: one run update (cursor moved, strike cleared) and the result');
 assert.deepEqual(rows(file,`SELECT cursor_kind,cursor_id,strike_count FROM ${RUN} WHERE run_key='epg:r1'`),[{cursor_kind:'film_facts',cursor_id:'film:tmdb:5',strike_count:0}]);
}

// ===== 5. The run row: origin blocks, strike columns, generation claim =====
if(on(5)){
 const file=fresh();
 // the CHECKs are judged alone, on a copy without the triggers that also refuse an odd new row (the birth shape, the dictionary guard): a mutant that removes one CHECK must not hide behind a trigger
 const checks=copyOf(open);assert.equal(bail(checks,'DROP TRIGGER canonical_producer_run_insert_shape;DROP TRIGGER canonical_producer_run_insert_dictionary_prev').status,0);
 const ok=over=>accepted(checks,insert(RUN,epgRun({run_key:'epg:x',...over})));
 const dict=over=>accepted(checks,insert(RUN,{...dictRun(2,H('c')),...over}));
 assert.ok(ok({}));assert.ok(dict({}));
 for(const [label,over] of [['no source generation',{source_generation:null}],['a dictionary field on an epg run',{seq:3}],['a prev_seq on an epg run',{prev_seq:0}],['a snapshot digest on an epg run',{snapshot_digest:H('c')}],['an unknown origin',{origin:'other'}],
  ['pass_no 0',{pass_no:0}],['pass_no 10001',{pass_no:10001}],['plan_version 0',{plan_version:0}],['short fingerprint',{fingerprint:'a'.repeat(63)}],['negative unit_count',{unit_count:-1}],['a half cursor (kind)',{cursor_kind:'film_facts'}],['a half cursor (id)',{cursor_id:'u1'}],
  ['a bad cursor kind',{cursor_kind:'Film',cursor_id:'u1'}],['an unknown pass_state',{pass_state:'done'}],['stopped_by while passing',{stopped_by:'producer_storage'}],['a bad stopped_by',{pass_state:'stopped',stopped_by:'Bad Code'}],
  ['a strike count of 3',{strike_count:3}],['a stored strike count of 3',{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:3}],['a strike kind with no count',{strike_kind:'film_facts'}],['a strike digest with a capital',{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('B'),strike_class:'c1',strike_count:1}],['a strike class with a digit first',{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'1c',strike_count:1}],['a strike kind with a capital',{strike_kind:'Film',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:1}],['a completed_at without the shape',{completed_at:'20261112T100000.000Z'}],['a created_at without the shape',{created_at:'20261112T100000.000Z'}],['an updated_at without the shape',{updated_at:'20261112T100000.000Z'}],['a strike count of -1',{strike_count:-1}],['a strike id with no count',{strike_id:'u1'}],['a count with no strike columns',{strike_count:1}],['a strike with no digest',{strike_kind:'film_facts',strike_id:'u1',strike_class:'c1',strike_count:1}],
  ['a strike with a short digest',{strike_kind:'film_facts',strike_id:'u1',strike_digest:'abc',strike_class:'c1',strike_count:1}],['a strike class that is no code',{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'Bad',strike_count:1}],
  ['an applied generation while passing',{applied_generation:'g1'}],['an applied generation that differs',{pass_state:'passed',applied_generation:'g2',open_at_completion:0}],['an applied generation without open_at_completion',{pass_state:'passed',applied_generation:'g1'}],
  ['a negative open_at_completion',{open_at_completion:-1}],['a negative generation',{marker_generation:-1}],['revision 0',{revision:0}],['a bad time',{created_at:'yesterday'}],['a time with a bad character',{created_at:BADTIME}],['a long time',{updated_at:LONGTIME}],['a time with an offset',{completed_at:ZONETIME}],['a bad updated_at character',{updated_at:BADTIME}],['a bad completed_at character',{completed_at:BADTIME}],['a long completed_at',{completed_at:LONGTIME}],['a bad completed_at',{completed_at:'x'}],['no created_at',{created_at:null}],
  ['a long run_key',{run_key:'x'.repeat(161)}],['an empty run_key',{run_key:''}]]){
  const errors=probe(checks,[insert(RUN,epgRun({run_key:'epg:x',...over}))])[0];
  assert.ok(errors.length>0,'refused: '+label);
 }
 // the dictionary block: seq, prev_seq = seq - 1, run_key d<seq>, a snapshot digest, no generation
 for(const [label,over] of [['no seq',{seq:null}],['no prev_seq',{prev_seq:null}],['prev_seq not seq - 1',{prev_seq:0}],['run_key not d<seq>',{run_key:'d9'}],['no snapshot digest',{snapshot_digest:null}],['a source generation',{source_generation:'g1'}],['seq 0',{seq:0,prev_seq:-1,run_key:'d0'}]]){
  assert.ok(probe(checks,[insert(RUN,{...dictRun(2,H('c')),...over})])[0].length>0,'refused: '+label);
 }
 // canonicalFreshness agrees with the CHECK on the generation claim: an `unknown` shape is a row the SQL refuses
 const GRID=[];
 for(const pass_state of ['passing','passed','stopped','superseded'])for(const applied of [null,'g1','g2'])GRID.push({pass_state,applied});
 const verdicts=GRID.map(({pass_state,applied})=>({pass_state,applied,fresh:R.canonicalFreshness({publishedGeneration:'g1',run:{source_generation:'g1',applied_generation:applied,pass_state},liveFilmFactsResults:0})}));
 const gridFile=copyOf(open);assert.equal(bail(gridFile,'DROP TRIGGER canonical_producer_run_insert_shape').status,0,'the CHECKs are judged alone: the birth-shape trigger is dropped on this copy');
 const grid=probe(gridFile,GRID.map(({pass_state,applied})=>insert(RUN,epgRun({run_key:'epg:g',pass_state,applied_generation:applied,open_at_completion:applied?0:null}))));
 verdicts.forEach((item,index)=>assert.equal(grid[index].length===0,item.fresh!=='unknown',JSON.stringify(item)+' '+grid[index].join('|')));
 assert.ok(verdicts.some(item=>item.fresh==='unknown')&&verdicts.some(item=>item.fresh==='current'));
 // a new run is born passing, pass 1, with nothing done
 for(const [label,over] of [['pass_no 2',{pass_no:2}],['passed',{pass_state:'passed'}],['a cursor',{cursor_kind:'film_facts',cursor_id:'u1'}],['a strike',{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:1}],['stopped',{pass_state:'stopped',stopped_by:'producer_storage'}],
  ['completed_at',{completed_at:AT}],['open_at_completion',{open_at_completion:0}],['revision 2',{revision:2}],['counts',{n_applied:1}],['counts (failed)',{n_failed:1}]]){
  refusedWith(file,insert(RUN,epgRun({run_key:'epg:x',...over})),/canonical_producer_run_insert/,'new run: '+label);
 }
 refusedWith(file,insert(RUN,epgRun({run_key:'epg:x',marker_generation:1})),/canonical_producer_stale_generation/,'a stale marker generation');
 refusedWith(file,insert(RUN,epgRun({run_key:'epg:x',marker_generation:3})),/canonical_producer_stale_generation/,'a future marker generation');
 refusedWith(file,insert(RUN,epgRun()),/UNIQUE constraint failed/,'the key is unique');
}

// ===== 6. The run row updates: identity, revision, generation claim, replay, compare-and-set =====
if(on(6)){
 const file=fresh();
 const refused=(patch,pattern,label,where)=>refusedWith(file,where?`UPDATE ${RUN} SET ${Object.entries(patch).map(([k,v])=>k+'='+q(v)).join(',')},revision=revision+1 WHERE ${where}`:runUpdate(patch),pattern,label);
 for(const [column,value] of [['origin','dictionary'],['run_key','epg:y'],['source_generation','g9'],['created_at','2026-11-12T11:00:00.000Z']])refused({[column]:value},/canonical_producer_run_immutable|constraint/,'immutable '+column);
 for(const [column,value] of [['seq',5],['prev_seq',4],['snapshot_digest',H('9')]])refused({[column]:value},/canonical_producer_run_immutable/,'immutable '+column,"run_key='d1' AND origin='dictionary'");
 refusedWith(file,`UPDATE ${RUN} SET updated_at=${q(AT)} WHERE run_key='epg:r1'`,/canonical_producer_run_revision/,'an update that does not bump the revision');
 refusedWith(file,`UPDATE ${RUN} SET updated_at=${q(AT)},revision=revision+2 WHERE run_key='epg:r1'`,/canonical_producer_run_revision/,'revision + 2');
 refusedWith(file,`UPDATE ${RUN} SET updated_at=${q(AT)},revision=revision-1 WHERE run_key='epg:r1'`,/canonical_producer_run_revision|constraint/,'revision - 1');
 assert.ok(accepted(file,runUpdate({updated_at:'2026-11-12T10:01:00.000Z'})));
 // a compare-and-set loses: the second writer with the old revision updates no row
 assert.equal(bail(file,`UPDATE ${RUN} SET updated_at=${q(AT)},revision=revision+1 WHERE run_key='epg:r1' AND revision=1`).status,0);
 assert.equal(Number(one(file,`SELECT revision FROM ${RUN} WHERE run_key='epg:r1'`)),2);
 assert.equal(Number(one(file,`UPDATE ${RUN} SET updated_at=${q(AT)},revision=revision+1 WHERE run_key='epg:r1' AND revision=1; SELECT changes()`)),0,'the stale writer changes nothing');
 refused({marker_generation:1},/canonical_producer_stale_generation/,'the generation never goes down');
 // the pass-complete commit: passed + applied_generation + open_at_completion in one update; then the claim never moves
 assert.ok(accepted(file,runUpdate({pass_state:'passed',applied_generation:'g1',open_at_completion:0,completed_at:'2026-11-12T10:30:00.000Z'})));
 assert.equal(bail(file,runUpdate({pass_state:'passed',applied_generation:'g1',open_at_completion:0,completed_at:'2026-11-12T10:30:00.000Z'})).status,0);
 refused({applied_generation:'g1',pass_state:'superseded'},/constraint|CHECK/,'a passed claim cannot be superseded');
 refused({applied_generation:null},/canonical_producer_run_applied/,'the claim cannot be taken back');
 refused({applied_generation:'g1',pass_state:'passing'},/constraint|CHECK/,'the claim needs a passed run');
 const f2=fresh();
 refusedWith(f2,runUpdate({applied_generation:'g2',pass_state:'passed',open_at_completion:0}),/CHECK constraint failed/,'the applied generation equals the source generation');
 // replay: pass_no + 1 with a new fingerprint, no cursor, no strike, passing, not stopped
 const f3=fresh();
 assert.equal(bail(f3,runUpdate({cursor_kind:'film_facts',cursor_id:'u1'})).status,0);
 const replay={pass_no:2,fingerprint:H('d'),cursor_kind:null,cursor_id:null,strike_count:0,pass_state:'passing',stopped_by:null,unit_count:5};
 assert.ok(accepted(f3,runUpdate(replay)));
 for(const [label,patch] of [['a replay that keeps the fingerprint',{fingerprint:H('a')}],['a replay that keeps the cursor',{cursor_kind:'film_facts',cursor_id:'u1'}],['a replay by two',{pass_no:3}],['a pass_no that goes down',{pass_no:1}],['a replay that stays stopped',{pass_state:'stopped',stopped_by:'producer_storage'}],
  ['a replay that keeps a strike',{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:1}]]){
  refusedWith(f3,runUpdate({...replay,...patch}),/canonical_producer_run_replay|canonical_producer_strike|CHECK/,label);
 }
 refusedWith(f3,runUpdate({fingerprint:H('d')}),/canonical_producer_run_replay/,'a new fingerprint without a replay');
 refusedWith(f3,runUpdate({plan_version:2}),/canonical_producer_run_replay/,'a new plan version without a replay');
 refusedWith(f3,runUpdate({unit_count:9}),/canonical_producer_run_replay/,'a new unit count without a replay');
 // the pure resumeDecision is the same move
 const decision=R.resumeDecision({stored:{fingerprint:H('a'),pass_no:1,cursor_kind:'film_facts',cursor_id:'u1'},fingerprint:H('d'),units:[{kind:'film_facts',id:'u2'}]});
 assert.equal(decision.action,'replay');
 assert.ok(accepted(f3,runUpdate({pass_no:decision.pass_no,fingerprint:decision.fingerprint,cursor_kind:decision.cursor_kind,cursor_id:decision.cursor_id,...decision.strike,pass_state:decision.pass_state,stopped_by:decision.stopped_by})));
 // no delete
 refusedWith(f3,`DELETE FROM ${RUN} WHERE run_key='epg:r1'`,/canonical_producer_immutable/,'no delete (run)');
}

// ===== 7. The strike triggers against strikeViolation: a differential over a strike universe and the six causes =====
if(on(7)){
 const file=fresh();
 const S=(id,digest,cls,count)=>count===0?{...R.NO_STRIKE}:{strike_kind:'film_facts',strike_id:id,strike_digest:H(digest),strike_class:cls,strike_count:count};
 const UNIVERSE=[S('u1','b','c1',0),S('u1','b','c1',1),S('u1','b','c1',2),S('u1','c','c1',1),S('u1','b','c2',1),S('u2','b','c1',1),S('u2','b','c1',2)];
 const CAUSES=['failure','unit_done','third_strike','plan_changed','systemic','cursor'];
 const step=patch=>runUpdate(patch);
 const cases=[];
 for(const a of UNIVERSE)for(const b of UNIVERSE)for(const cause of CAUSES)for(const cursorStart of (cause==='plan_changed'||cause==='unit_done'?[true,false]:[true])){
  // the cursor starts at u0, or (for a plan change and a unit outcome) at no cursor: then a reset cannot hide behind "the cursor moved"
  const prefix=cursorStart?[step({cursor_kind:'film_facts',cursor_id:'u0'})]:[];
  if(a.strike_count>=1)prefix.push(step({...a,strike_count:1}));
  if(a.strike_count===2)prefix.push(step(a));
  const extra={failure:{},unit_done:{cursor_kind:'film_facts',cursor_id:'u9'},third_strike:{cursor_kind:'film_facts',cursor_id:'u9'},cursor:{cursor_kind:'film_facts',cursor_id:'u9'},plan_changed:{pass_no:2,fingerprint:H('d'),cursor_kind:null,cursor_id:null,pass_state:'passing',stopped_by:null},systemic:{pass_state:'stopped',stopped_by:'producer_storage'}}[cause];
  cases.push({a,b,cause,pure:R.strikeViolation(a,b,cause)===null,statements:[...prefix,step({...b,...extra})]});
 }
 const errors=probe(file,cases.map(item=>item.statements));
 const differences=new Map();
 cases.forEach((item,index)=>{
  const sqlOk=errors[index].length===0;
  if(sqlOk===item.pure)return;
  const unchanged=JSON.stringify(item.a)===JSON.stringify(item.b);
  let reason;
  // (1) the SQL cannot tell WHICH unit a cursor move belongs to: a reset with a cursor move for "another unit" passes (strikeStep never produces it: a unit's own success clears only its own strike)
  if(item.cause==='cursor'&&item.b.strike_count===0&&item.a.strike_count>0&&sqlOk&&!item.pure)reason='cursor_move_for_another_unit';
  // (2) strikeViolation accepts a plan change that leaves the strike in place; strikeStep never produces one (it clears the strike) and the SQL replay rule refuses it
  else if(item.cause==='plan_changed'&&unchanged&&item.a.strike_count>0&&!sqlOk&&item.pure)reason='plan_change_keeping_a_strike';
  else throw new Error('an UNEXPECTED difference between strikeViolation and the SQL: '+JSON.stringify({a:item.a,b:item.b,cause:item.cause,pure:item.pure,sqlOk,text:errors[index].join('|')}));
  differences.set(reason,(differences.get(reason)||0)+1);
 });
 assert.deepEqual([...differences.keys()].sort(),['cursor_move_for_another_unit','plan_change_keeping_a_strike']);
 assert.ok(cases.filter((item,index)=>(errors[index].length===0)===item.pure).length>=330,'the strike rules agree on nearly every pair');
 // the strike machine's own steps are all accepted: a stop leaves the strike (and a stopped run cannot move its strike), a refusal moves the cursor and clears only its own strike
 const run0={cursor_kind:null,cursor_id:null,pass_no:1,pass_state:'passing',stopped_by:null,...R.NO_STRIKE};
 const unit={kind:'film_facts',id:'film:tmdb:7',digest:H('b')};
 let run=R.strikeStep(run0,{type:'unit_failed',unit,error:{code:'identity_collision'}}).run;
 assert.ok(accepted(file,[step({strike_kind:run.strike_kind,strike_id:run.strike_id,strike_digest:run.strike_digest,strike_class:run.strike_class,strike_count:run.strike_count})]));
 const stop=R.strikeStep(run,{type:'systemic',error:{code:'producer_storage'}});
 assert.equal(stop.action,'stop');
 assert.ok(accepted(file,[step({strike_kind:run.strike_kind,strike_id:run.strike_id,strike_digest:run.strike_digest,strike_class:run.strike_class,strike_count:run.strike_count}),step({pass_state:'stopped',stopped_by:stop.run.stopped_by})]));
 // a failed batch leaves BOTH the strike count and the cursor as they were (the batch is one transaction): the third-strike batch whose result row is refused changes nothing
 {
  const third=fresh();
  const two=[{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:1},{strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:2}];
  assert.equal(bail(third,two.map(step).join(';\n')).status,0);
  const state=()=>JSON.stringify(rows(third,`SELECT cursor_kind,cursor_id,strike_count,revision FROM ${RUN} WHERE run_key='epg:r1'`));
  const was=state();
  const badResult=resultInsert({...BASES.open_unit,state:'open',next_attempt_at:null});
  const crashed=bail(third,'BEGIN;\n'+step({cursor_kind:'film_facts',cursor_id:'u1',strike_kind:null,strike_id:null,strike_digest:null,strike_class:null,strike_count:0})+';\n'+badResult+';\nCOMMIT;');
  assert.notEqual(crashed.status,0,'the batch fails');
  assert.equal(state(),was,'count, cursor and revision are exactly as before the failed batch');
  // and the same batch with a valid result row commits whole
  const good=bail(third,'BEGIN;\n'+step({cursor_kind:'film_facts',cursor_id:'u1',strike_kind:null,strike_id:null,strike_digest:null,strike_class:null,strike_count:0})+';\n'+resultInsert({...BASES.open_unit,unit_id:'u1',attempts:3})+';\nCOMMIT;');
  assert.equal(good.status,0,message(good));
  assert.deepEqual(rows(third,`SELECT cursor_id,strike_count FROM ${RUN} WHERE run_key='epg:r1'`),[{cursor_id:'u1',strike_count:0}]);
 }
 // a stopped update that also adds a strike is refused; so is one that clears it
 refusedWith(file,[step({pass_state:'stopped',stopped_by:'producer_storage',strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:1})],/canonical_producer_strike_stop/,'a stop never adds a strike');
 // a run that is ALREADY stopped cannot move its strike while it stays stopped (the ADR: an update that sets pass_state or stopped_by leaves the strike columns untouched)
 refusedWith(file,[step({pass_state:'stopped',stopped_by:'producer_storage'}),step({stopped_by:'producer_timeout',strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:1})],/canonical_producer_strike_stop/,'a stopped run adding a strike');
 // a stopped run resumes (passing again) and the strike moves normally
 assert.ok(accepted(file,[step({pass_state:'stopped',stopped_by:'producer_storage'}),step({pass_state:'passing',stopped_by:null,strike_kind:'film_facts',strike_id:'u1',strike_digest:H('b'),strike_class:'c1',strike_count:1})]));
}

// ===== 8. The dictionary version mint (scenario B): the guard triggers and the unique (origin, seq) index =====
if(on(8)){
 const file=copyOf(open);
 const history=[];
 const mint=(digest,over={})=>{
  const latest=history.length?{seq:history.length,run_key:'d'+history.length,snapshot_digest:history[history.length-1]}:null;
  const decision=R.mintDictionaryVersion({latest,snapshotDigest:digest});
  if(decision.action==='reuse')return decision;
  const sqlRow=dictRun(decision.seq,digest,over);
  assert.equal(sqlRow.run_key,decision.run_key);assert.equal(sqlRow.prev_seq,decision.prev_seq);
  const statements=[insert(RUN,sqlRow)];
  if(decision.supersedes)statements.push(runUpdate({pass_state:'superseded'},decision.supersedes,'dictionary'));
  assert.equal(bail(file,statements.join(';\n')).status,0,'the mint of d'+decision.seq+' is accepted');
  history.push(digest);return decision;
 };
 // A, B, A gives d1, d2, d3 (a revert is a genuine new version); a repeat of A reuses d3
 assert.deepEqual([mint(H('a')).run_key,mint(H('b')).run_key,mint(H('a')).run_key],['d1','d2','d3']);
 assert.equal(mint(H('a')).action,'reuse');
 assert.deepEqual(rows(file,`SELECT run_key,pass_state FROM ${RUN} ORDER BY seq`),[{run_key:'d1',pass_state:'superseded'},{run_key:'d2',pass_state:'superseded'},{run_key:'d3',pass_state:'passing'}]);
 // two planners that both read d3 compute d4: the second INSERT hits the unique (origin, seq) index; it then re-reads and reuses (same digest) or mints d5 (a different one)
 assert.equal(mint(H('c')).run_key,'d4');
 refusedWith(file,insert(RUN,dictRun(4,H('c'))),/UNIQUE constraint failed/,'the loser of a race');
 refusedWith(file,insert(RUN,dictRun(4,H('d'))),/UNIQUE constraint failed/,'the loser holding another digest');
 assert.equal(mint(H('d')).run_key,'d5');
 // the guards: no gap, no first mint over history, no mint over an equal digest, no mint without the previous row
 refusedWith(file,insert(RUN,dictRun(7,H('e'))),/canonical_producer_dictionary_prev/,'a gap (d7 over d5)');
 refusedWith(file,insert(RUN,dictRun(6,H('d'))),/canonical_producer_dictionary_prev/,'d6 over an equal digest (it would reuse)');
 refusedWith(file,insert(RUN,{...dictRun(1,H('e')),run_key:'d1'}),/UNIQUE constraint failed|canonical_producer_dictionary_not_first/,'d1 again');
 const empty=copyOf(open);
 refusedWith(empty,insert(RUN,dictRun(2,H('e'))),/canonical_producer_dictionary_prev/,'d2 with no d1');
 assert.ok(accepted(empty,insert(RUN,dictRun(1,H('e')))));
 const first=copyOf(open);seedRuns(first);
 refusedWith(first,insert(RUN,{...dictRun(2,H('c')),seq:2,prev_seq:0,run_key:'d2'}),/CHECK constraint failed|canonical_producer_dictionary_not_first/,'prev_seq must be seq - 1 (the guard trigger or the CHECK)');
 // an epg run is not a dictionary version: the guards do not apply to it
 assert.ok(accepted(file,insert(RUN,epgRun({run_key:'epg:other'}))));
}

// ===== 9. The result updates: identity, owner, attempts, state moves; no delete =====
if(on(9)){
 const file=fresh();
 const rowA=BASES.open_unit,rowB={...BASES.recoverable,unit_id:'film:tmdb:2'},rowC={...BASES.open_receipt,unit_id:'film:tmdb:3'};
 for(const row of [rowA,rowB,rowC])assert.equal(bail(file,resultInsert(row)).status,0);
 const refused=(row,patch,pattern,label)=>refusedWith(file,patchSql(row,patch),pattern,label);
 for(const [column,value] of [['origin','dictionary'],['run_key','epg:r2'],['pass_no',2],['kind','film_credits'],['unit_id','film:tmdb:99'],['fingerprint',H('c')],['unit_digest',H('c')],['created_at','2026-11-12T11:00:00.000Z']])refused(rowA,{[column]:value},/canonical_producer_result_immutable|FOREIGN KEY/,'immutable '+column);
 refused(rowA,{retry_owner:'receipt',request_id:'x',next_attempt_at:null},/canonical_producer_result_immutable/,'the owner never changes');
 refused(rowC,{request_id:'epg:r1:other'},/canonical_producer_result_immutable/,'the request id never changes');
 refused(rowA,{attempts:2},/canonical_producer_result_attempts/,'attempts never go down');
 refused(rowA,{attempts:5},/canonical_producer_result_attempts/,'attempts rise by one at most');
 assert.ok(accepted(file,patchSql(rowA,{attempts:4,updated_at:AT})));
 assert.ok(accepted(file,patchSql(rowA,{updated_at:AT})),'attempts may stay');
 // the three live states move to each other and to any terminal state; the CHECKs (not the trigger) decide the fields of each target state
 assert.ok(accepted(file,patchSql(rowB,{state:'refused_permanent',code:'film_person_invalid',prereq_stamp:null,next_attempt_at:null,updated_at:AT})));
 assert.ok(accepted(file,patchSql(rowA,{state:'refused_recoverable',code:'no_identity_row',prereq_stamp:H('e'),next_attempt_at:'2026-11-12T10:10:00.000Z',attempts:3})));
 for(const [state,settled_by] of [['settled','applied'],['superseded','source_changed'],['abandoned','retry_exhausted']])assert.ok(accepted(file,patchSql(rowA,{state,settled_at:AT,settled_by,next_attempt_at:null})),'live to '+state);
 refused(rowA,{state:'settled',settled_at:AT,settled_by:'applied'},/CHECK constraint failed/,'a terminal row keeps no schedule');
 refused(rowA,{state:'settled',settled_by:'applied',next_attempt_at:null},/CHECK constraint failed/,'a terminal row needs settled_at');
 refused(rowA,{state:'settled',settled_at:AT,next_attempt_at:null},/CHECK constraint failed/,'a terminal row needs settled_by');
 refused(rowA,{settled_by:'applied'},/CHECK constraint failed/,'a live row has no settled_by');
 refused(rowC,{state:'refused_recoverable',code:'no_identity_row',prereq_stamp:H('e'),next_attempt_at:AT},/CHECK constraint failed/,'a receipt-owned row is never a recoverable refusal and never has a schedule');
 refusedWith(file,`DELETE FROM ${RES} WHERE ${keyWhere(rowA)}`,/canonical_producer_immutable/,'no delete (result)');
 // a failed update leaves the row as it was
 assert.equal(one(file,`SELECT state FROM ${RES} WHERE ${keyWhere(rowC)}`),'open');
}

// ===== 10. Dormancy: nothing bundles, reads or applies the tables or the file =====
if(on(10)){
 const grep=(dir,needle)=>{const hits=[];for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())hits.push(...grep(file,needle));else if(/\.(js|mjs|json|jsonc|yml)$/.test(entry.name)&&fs.readFileSync(file,'utf8').includes(needle))hits.push(file);}return hits;};
 const named=needle=>grep('src',needle).filter(file=>file!=='src/canonical-producer-run.js');
 // the dormant pure module names the tables in comments only; it is imported by tests alone (tests/canonical-receipts.mjs keeps the importer list)
 assert.deepEqual(named('canonical_producer_run'),[],'no Worker code names the run table');
 assert.deepEqual(named('canonical_producer_unit_result'),[],'no Worker code names the result table');
 assert.deepEqual(named('0020_canonical_producer_run'),[]);
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('canonical-producer-run'),'the pure module and the migration are not bundled');
 assert.ok(!fs.readFileSync('wrangler.jsonc','utf8').includes('migrations'),'wrangler.jsonc has no migrations directory: a deploy applies nothing');
 for(const file of fs.readdirSync('.github/workflows'))assert.ok(!/d1\s+(execute|migrations)|migrations\s+apply|0020_canonical/.test(fs.readFileSync('.github/workflows/'+file,'utf8')),file+' applies no migration');
 const statements=text20.split('\n').filter(line=>/^(INSERT|CREATE|UPDATE)\b/.test(line)).length;
 assert.equal(statements,34,'34 statements');
}
console.log('canonical-producer-schema: migration 0020 (schema 20) on the sqlite stand-in: the result row, run row, strike, replay, mint and state-machine rules agree with the pure module, with the known differences pinned.');
