// Moves the broadcast-related timestamps of an exported snapshot forward so a
// stale private export behaves like a programme refreshed today. Local
// development only: nothing here runs in the Worker or touches production.
export const DAY_MS=86400000;

// Whole days needed to bring `updatedAt` into the last 24 hours before `now`.
// Shifting by whole days keeps every show at its original hour of the day.
export function shiftDaysToNow(updatedAt,now=Date.now()){
 const at=typeof updatedAt==='number'?updatedAt:Date.parse(String(updatedAt??''));
 if(!Number.isFinite(at))return 0;
 return Math.max(0,Math.floor((now-at)/DAY_MS));
}

const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function shiftValue(value,delta){
 if(typeof value==='number')return Number.isFinite(value)?value+delta:value;
 if(typeof value==='string'&&ISO.test(value)){const time=Date.parse(value);return Number.isNaN(time)?value:new Date(time+delta).toISOString();}
 return value;
}
function shiftFields(object,fields,delta){
 if(!object||typeof object!=='object'||Array.isArray(object))return object;
 const out={...object};
 for(const field of fields)if(field in out)out[field]=shiftValue(out[field],delta);
 return out;
}
function shiftShows(item,delta){
 if(!item||typeof item!=='object'||!Array.isArray(item.shows))return item;
 return {...item,shows:item.shows.map(show=>shiftFields(show,['start','end'],delta))};
}
function shiftList(list,delta,fields){return Array.isArray(list)?list.map(item=>shiftShows(shiftFields(item,fields,delta),delta)):list;}

const handlers={
 programme(report,delta){
  const out=shiftFields(report,['updatedAt','watchlistUpdatedAt','cutoff'],delta);
  if(report.window)out.window=shiftFields(report.window,['from','to'],delta);
  if(report.stats)out.stats=shiftFields(report.stats,['epgStart','epgEnd'],delta);
  if(Array.isArray(report.films))out.films=shiftList(report.films,delta,['availableUntil']);
  return out;
 },
 watchlist(list,delta){return shiftFields(list,['updatedAt'],delta);},
 sync(state,delta){
  const out=shiftFields(state,['startedAt','updatedAt'],delta);
  if(Array.isArray(state.events))out.events=state.events.map(event=>shiftFields(event,['at'],delta));
  return out;
 },
 discoveryLatest(latest,delta){
  const out=shiftFields(latest,['updatedAt'],delta);
  if(Array.isArray(latest.items))out.items=shiftList(latest.items,delta,['firstAiring','lastAiring']);
  return out;
 },
 discoveredFilms(catalog,delta){
  if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))return catalog;
  return Object.fromEntries(Object.entries(catalog).map(([id,film])=>[id,shiftShows(shiftFields(film,['epgLastAiring'],delta),delta)]));
 },
 // Only programme and watchlist history follows the shifted programme. Prediction
 // runs and started markers keep their real timestamps, and so do their events.
 event(event,delta){return event&&(event.type==='epg'||event.type==='watchlist')?shiftFields(event,['at'],delta):event;},
};

// Which handler applies to a stored key. Staged EPG generations keep the
// published object names under epg/generations/<runId>/.
export function timeShiftHandler(key){
 const name=String(key||'').replace(/^epg\/generations\/[^/]+\//,'');
 if(name==='programme.json')return 'programme';
 if(name==='watchlist.json')return 'watchlist';
 if(name==='sync.json')return 'sync';
 if(name==='epg/discovery-latest.json'||name==='discovery-latest.json')return 'discoveryLatest';
 if(name==='epg/discovered-films.json'||name==='discovered-films.json')return 'discoveredFilms';
 if(/^events\/items\/[^/]+\.json$/.test(name))return 'event';
 return null;
}
export function isTimeShifted(key){return timeShiftHandler(key)!==null;}

// Returns a shifted copy for time-bearing objects and the same value otherwise.
export function shiftSnapshotObject(key,json,delta){
 const handler=timeShiftHandler(key);
 if(!handler||!delta||!json||typeof json!=='object')return json;
 return handlers[handler](json,delta);
}
