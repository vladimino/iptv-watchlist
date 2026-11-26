// AIR-619 / ADR 0215 (Accepted), card E2c: the `discovery_owner` evidence writer (Table 3, decision 6). DORMANT by its control row: with no `identity_evidence_writer` row for
// `discovery_owner` (absent, `off`) the owner write below appends statements that insert nothing, so the Discovery batch commits exactly the domain effect it commits today.
// Only the owner-approved activation operation (a separate gate, never reachable from the Worker) makes it write rows. Nothing here READS the ledger to decide anything (ADR 0213 decision 8).
//
// What it provides, for `commitOwnerWrite` in src/discovery-authority.js (the only path that commits an owner intent):
// - `planOwnerEvidence`: pure planning of the rows of one owner intent, from the stored intent alone:
//     `identity_assign`  -> `candidate_for(observation, tmdb_movie)` `asserts`, root = the intent key, time = `ownerIdentity.at` (confirm, correct and each child of a group
//                           assign are the same intent kind, each child its own intent, so its own batch and row);
//     `identity_reject`  -> the same proposition `refutes`, time = the intent's `confirmedAt`;
//     `identity_revoke`  -> the revoked intent's proposition `refutes`, SCOPED: `scope_evidence_key` = the exact key of the revoked intent's row (assign: its `asserts` row,
//                           reject: its `refutes` row). The key is deterministic, so a revoke of an intent made before the writer was active still names the key its
//                           reconstruction will write (a forward reference);
//     a replacement (`command.supersedes`) of an assign or reject also writes ONE scoped withdrawal of the superseded intent's row, in the same batch, with the same root,
//     time and source order. Same candidate or another candidate, the shape is the same. A reinstatement is a new intent and therefore a new `asserts` row;
//     `reconsider` and every other writer of `commitOwnerWrite` -> no row (it states no identity).
//   Every row carries `source_order` = the observation's `discovery_decision_history.revision` of the very batch that writes the action (MAX+1 inside the batch). Precedence
//   is decided by readers from it within one observation; `seq` never decides anything (decision 6).
// - `ownerEvidenceStatements`: the statements `commitOwnerWrite` splices into its batch after the decision CAS and before the intent receipt:
//     per row the conditional insert and its assertion of `domainEvidenceStatements` (written only while `discovery_owner` is `pending` or `on`, atomic when active, silent when
//     not), then ONE assertion that the history revision this batch just wrote is the planned `source_order` (a stale plan rolls the batch back while active).
//   The Discovery assertion is `UPDATE discovery_cas SET ok=CASE ...` (the table's CHECK is the rollback). A schema without the control tables gets ONE commit-time guard.
//   A step that is eligible but cannot be planned (a missing `confirmedAt`, a malformed key) gets a guard that fails the batch while the writer is active, so an active writer
//   never commits an owner step without its row; `off` is unchanged.
import {evidenceKeyOf,normalizeEvidence} from './identity-evidence.js';
import {ABSENT,domainEvidenceStatements,identityEvidenceControlStatus,planDomainEvidence} from './identity-evidence-writer.js';

export const OWNER_WRITER='discovery_owner';
const KIND_EFFECT=Object.freeze({identity_assign:'assign',identity_reject:'reject',identity_revoke:'revoke'});
const KEY_TIME='1970-01-01T00:00:00.000Z';
const ACTIVE="EXISTS (SELECT 1 FROM identity_evidence_writer WHERE writer=? AND state IN ('pending','on'))";
const assertSql=condition=>'UPDATE discovery_cas SET ok=CASE WHEN ('+condition+') THEN 1 ELSE 0 END WHERE id=1';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const unplannable=()=>new Error('discovery_owner_evidence_unplannable');

const row=({key,tmdbId,polarity,requestId,scope=null,at,order})=>({
 subject:{kind:'discovery_observation',value:key},relation:'candidate_for',object:{kind:'tmdb_movie',value:String(tmdbId)},polarity,route:'owner_action',method:'owner_statement',
 sourceRoot:requestId,scopeEvidenceKey:scope,observedAt:at,sourceOrder:order,
});

// The deterministic key of the row an owner intent of `effect` writes for `tmdbId` with idempotency key `requestId`. The time and order are not part of a key.
export async function ownerRowKey({key,effect,tmdbId,requestId}){
 if(effect!=='assign'&&effect!=='reject')throw unplannable();
 return evidenceKeyOf(normalizeEvidence(row({key,tmdbId,polarity:effect==='assign'?'asserts':'refutes',requestId,at:KEY_TIME,order:1})));
}

// Pure (async for SHA-256). `intent` is the stored discovery_intent, `superseded` the stored intent `command.supersedes` names (or null), `next` the decision this write
// installs, `revision` the history revision the batch will write. Returns {eligible:false} (no row by design), {eligible:true,plans:[...]} or {eligible:true,plans:null}
// (eligible, but the stored intent cannot yield a valid row: see the header).
export async function planOwnerEvidence({intent,superseded=null,key,next,revision}){
 const effect=KIND_EFFECT[intent?.kind];
 if(!effect)return {eligible:false};
 try{
  const command=intent.command,requestId=intent.idempotencyKey;
  if(!plain(command)||command.effect!==effect||typeof key!=='string'||typeof requestId!=='string')throw unplannable();
  const confirmedAt=plain(intent.issued)?intent.issued.confirmedAt:null;
  const plans=[];
  if(effect==='revoke'){
   const revokes=command.revokes;
   if(!plain(revokes)||typeof revokes.requestId!=='string')throw unplannable();
   const scope=await ownerRowKey({key,effect:revokes.effect,tmdbId:revokes.tmdbId,requestId:revokes.requestId});
   plans.push(await planDomainEvidence(OWNER_WRITER,row({key,tmdbId:revokes.tmdbId,polarity:'refutes',requestId,scope,at:confirmedAt,order:revision})));
   return {eligible:true,plans};
  }
  let at=confirmedAt;
  if(effect==='assign'){
   const owner=next?.ownerIdentity;
   if(!plain(owner)||owner.effect!=='assign'||owner.requestId!==requestId||String(owner.tmdbId)!==String(command.tmdbId))throw unplannable();
   at=owner.at;
  }
  plans.push(await planDomainEvidence(OWNER_WRITER,row({key,tmdbId:command.tmdbId,polarity:effect==='assign'?'asserts':'refutes',requestId,at,order:revision})));
  if(command.supersedes!==undefined&&command.supersedes!==null){
   const sup=command.supersedes;
   const before=KIND_EFFECT[superseded?.kind];
   if(!plain(sup)||!plain(superseded)||superseded.idempotencyKey!==sup.requestId||(before!=='assign'&&before!=='reject')||superseded.observationKey!==key)throw unplannable();
   const scope=await ownerRowKey({key,effect:before,tmdbId:superseded.command?.tmdbId,requestId:superseded.idempotencyKey});
   plans.push(await planDomainEvidence(OWNER_WRITER,row({key,tmdbId:superseded.command.tmdbId,polarity:'refutes',requestId,scope,at,order:revision})));
  }
  return {eligible:true,plans};
 }catch(error){
  if(error?.message==='discovery_owner_evidence_unplannable'||error?.code==='identity_evidence_invalid'||error?.code==='identity_evidence_out_of_slice')return {eligible:true,plans:null};
  throw error;
 }
}

// The statements of one owner write, [] when the step writes no row. `at` is the batch clock; `requestId` the intent key.
export async function ownerEvidenceStatements(env,{plan,key,requestId,at,revision}){
 if(!plan?.eligible)return [];
 const status=await identityEvidenceControlStatus(env);
 if(status==='absent')return [[assertSql(ABSENT),[]]];
 if(plan.plans===null)return [[assertSql('NOT '+ACTIVE),[OWNER_WRITER]]];
 const statements=[];
 for(const item of plan.plans)statements.push(...await domainEvidenceStatements(env,item,{requestId,at,assertSql}));
 statements.push([assertSql('NOT '+ACTIVE+' OR (SELECT MAX(revision) FROM discovery_decision_history WHERE observation_key=?)=?'),[OWNER_WRITER,key,revision]]);
 return statements;
}
