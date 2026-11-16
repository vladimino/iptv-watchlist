// ADR 0142 decisions 5 and 6: the per-slot evidence rule of an assigned broadcast slot. Pure; no storage, no TMDB.
//
// A slot of an observation is eligible for the Film of the observation's verified decision when one of these holds:
//  1. the owner assigned the decision (identitySource 'owner');
//  2. the scan of the pinned run confirmed the same TMDB id on this slot (a legacy observation without per-slot ids uses the observation id);
//  3. the slot's duration is within the anchor tolerance of an anchored duration of the decision.
// The anchor holds only durations that were verified one by one. The accumulated durations of an evidence key are observed, not verified.

export const ANCHOR_DURATION_LIMIT=12;

export function slotMinutes(startMs,endMs){
 const start=Number(startMs),end=Number(endMs);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
 return Math.round((end-start)/60000);
}

export function anchorTolerance(anchored){
 return Math.min(10,Math.max(5,0.05*anchored));
}

function wholeMinutes(value){
 const number=Number(value);
 return Number.isFinite(number)&&number>0?Math.round(number):null;
}

export function normalizedDurations(values){
 return [...new Set((Array.isArray(values)?values:[]).map(wholeMinutes).filter(value=>value!=null))].sort((a,b)=>a-b);
}

// The durations of a stored evidence key `normalizedTitle|year|durations|shows`, read from the end because only the title part may contain a separator.
export function evidenceKeyDurations(evidenceKey){
 if(typeof evidenceKey!=='string')return [];
 const parts=evidenceKey.split('|');
 if(parts.length<4)return [];
 const field=parts[parts.length-2];
 if(!field)return [];
 return normalizedDurations(field.split(',').map(Number));
}

// The anchor of a stored decision. A decision written by the implementation carries `anchor` (an array of verified whole minutes).
// A decision written before it keeps an anchor only when its evidence key records exactly one duration: the scorer and the detail gate
// then saw that duration alone. With two or more recorded durations no duration is promoted, and no rule infers one from the runtime.
export function decisionAnchor(decision){
 if(!decision||typeof decision!=='object')return [];
 if(Array.isArray(decision.anchor))return normalizedDurations(decision.anchor);
 if(decision.identitySource!=='tmdb_detail')return [];
 const recorded=evidenceKeyDurations(decision.evidenceKey);
 return recorded.length===1?recorded:[];
}

// Slots listed in confirmedSlots are confirmed one by one. An observation that has the list does not lend its id to a slot that is absent from it.
export function slotScanConfirmation(observation,slot){
 if(Array.isArray(observation?.confirmedSlots)){
  const hit=observation.confirmedSlots.find(item=>item&&String(item.channelId)===String(slot?.channelId)&&Number(item.start)===Number(slot?.start??slot?.startMs));
  return hit?.tmdbId??null;
 }
 return observation?.confirmedTmdbId??null;
}
export function slotEligibility(decision,slot,confirmedTmdbId=null){
 if(!decision||decision.status!=='verified')return {eligible:false,rule:null};
 if(decision.identitySource==='owner')return {eligible:true,rule:'owner'};
 if(confirmedTmdbId!=null&&String(confirmedTmdbId)===String(decision.tmdbId))return {eligible:true,rule:'scan_confirmed'};
 const minutes=slotMinutes(slot?.start??slot?.startMs,slot?.end??slot?.endMs);
 if(minutes==null)return {eligible:false,rule:null};
 for(const anchored of decisionAnchor(decision))if(Math.abs(minutes-anchored)<=anchorTolerance(anchored))return {eligible:true,rule:'anchor'};
 return {eligible:false,rule:null};
}

// ADR 0142 decision 6: bounded automatic revalidation of a drifted duration. Pure; the resolver does the TMDB work and calls these for the records.
export const REVALIDATION_LIMIT=12;

export function failedDurations(decision){
 return normalizedDurations(decision?.failedDurations);
}

// Which drifted durations (whole minutes of the slots that no rule makes eligible) still get one evaluation. An owner decision is never revalidated;
// a duration already in the anchor or in the failed durations gets no further call; twelve failed durations end automatic revalidation for good.
export function revalidationPlan(decision,minutes){
 if(!decision||typeof decision!=='object'||decision.status!=='verified'||decision.identitySource==='owner'||decision.ownerIdentity)return {eligible:false,anchor:[],failed:[],exhausted:false,todo:[]};
 const anchor=decisionAnchor(decision),failed=failedDurations(decision);
 const exhausted=failed.length>=REVALIDATION_LIMIT;
 const todo=exhausted?[]:normalizedDurations(minutes).filter(value=>!anchor.includes(value)&&!failed.includes(value));
 return {eligible:true,anchor,failed,exhausted,todo};
}

// The decision written after an attempt: the same status, TMDB id and Film id. A reconfirmed duration joins the anchor (the earlier anchor stays, and a legacy
// one-duration anchor is stored here for the first time); a duration that was not reconfirmed joins the failed durations. Nothing else of the identity changes.
export function revalidatedDecision(decision,{reconfirmed=[],failed=[],proposedTmdbId=null},{evidenceKey,checkedAt,provenance=null}){
 const next={...decision,anchor:normalizedDurations([...decisionAnchor(decision),...reconfirmed]),failedDurations:normalizedDurations([...failedDurations(decision),...failed]),evidenceKey,checkedAt};
 if(reconfirmed.length){next.identitySource='tmdb_detail';if(provenance)next.provenance=provenance;delete next.proposedTmdbId;}
 else if(proposedTmdbId!=null&&String(proposedTmdbId)!==String(decision.tmdbId))next.proposedTmdbId=String(proposedTmdbId);
 return next;
}
