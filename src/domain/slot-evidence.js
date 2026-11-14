// ADR 0142 decisions 5 and 6: the per-slot evidence rule of an assigned broadcast slot. Pure; no storage, no TMDB.
//
// A slot of an observation is eligible for the Film of the observation's verified decision when one of these holds:
//  1. the owner assigned the decision (identitySource 'owner');
//  2. the scan of the pinned run confirmed the same TMDB id on the observation;
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
 const recorded=evidenceKeyDurations(decision.evidenceKey);
 return recorded.length===1?recorded:[];
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
