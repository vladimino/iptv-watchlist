// AIR-374. Pure, DORMANT grouping of the blocker strings that handoffReadiness (the producers module) returns, by the kind of work that clears them. Nothing in the Worker
// imports this module (it is not bundled). It reads no database and no registry, never changes the readiness verdict, and adds no blocker: it only sorts strings it is given.
// A blocker whose prefix is not listed lands in `unclassified`, so a new blocker kind cannot be silently dropped from a report.
export const BLOCKER_CLASSES=Object.freeze(['registry_code','data_load','owner_exception','read_move','operational_state']);
// empty_class_unreadable is a missing table or a failed COUNT(*) read: running the H1 load cannot fix it, so it is operational state, not data_load. empty_class_not_loaded is the only data_load
// kind, and a count above the expected one or a nonzero mismatch needs diagnosis, never blind insertion. reader_class_invalid and reader_exception_marked_moved are registry entries that need a code correction.
// prefix (the text before the first colon, or the whole string) -> class
const RULES=Object.freeze({
 producer_not_wired:'registry_code',receipts_protocol_unregistered:'registry_code',gap:'registry_code',
 empty_class_not_loaded:'data_load',empty_class_unreadable:'operational_state',
 exception_not_accepted:'owner_exception',
 reader_not_moved:'read_move',reader_exception_marked_moved:'registry_code',reader_class_invalid:'registry_code',
 marker_unreadable:'operational_state',marker_not_prepared:'operational_state',baseline_not_verified:'operational_state',schema_below_16:'operational_state',schema_unreadable:'operational_state',
 no_database:'operational_state',now_invalid:'operational_state',projector_lease_live:'operational_state',projector_lease_unreadable:'operational_state',
 projector_window_not_idle:'operational_state',projector_window_unreadable:'operational_state',receipts_schema_missing:'operational_state',receipts_baseline_missing:'operational_state',
 receipts_baseline_unverified:'operational_state',unreceipted_changes:'operational_state',receipts_attention_open:'operational_state',receipts_unreadable:'operational_state',
});
export const classOfBlocker=blocker=>{const text=String(blocker);const at=text.indexOf(':');const prefix=at<0?text:text.slice(0,at);return Object.prototype.hasOwnProperty.call(RULES,prefix)?RULES[prefix]:'unclassified';};
export function classifyBlockers(readiness){
 const list=Array.isArray(readiness)?readiness:Array.isArray(readiness?.blockers)?readiness.blockers:[];
 const byClass={};for(const name of [...BLOCKER_CLASSES,'unclassified'])byClass[name]=[];
 for(const blocker of list)byClass[classOfBlocker(blocker)].push(String(blocker));
 const counts={};for(const name of Object.keys(byClass))counts[name]=byClass[name].length;
 return {total:list.length,counts,byClass};
}
