// Moves the broadcast-related timestamps of an exported snapshot forward so a
// stale private export behaves like a programme refreshed today. Local
// development only: nothing here runs in the Worker or touches production.
//
// The shift is a whole number of *calendar days in the site's time zone*, not
// a multiple of 24 hours: a show that aired at 21:00 in Madrid still starts at
// 21:00 Madrid time after the shift, even when a DST transition lies between
// the original and the shifted date. All timestamps of one import go through
// the same wall-clock mapping, so relative order is preserved and the window,
// the shows and the update markers stay consistent with each other.
export const DAY_MS=86400000;
export const LOCAL_TIME_ZONE='Europe/Madrid';

const formatters=new Map();
function partsFormatter(timeZone){
 if(!formatters.has(timeZone))formatters.set(timeZone,new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}));
 return formatters.get(timeZone);
}
// Offset of `timeZone` from UTC at instant `time`, in milliseconds.
export function zoneOffsetMs(time,timeZone=LOCAL_TIME_ZONE){
 const parts={};
 for(const part of partsFormatter(timeZone).formatToParts(new Date(time)))if(part.type!=='literal')parts[part.type]=Number(part.value);
 const wall=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
 return wall-Math.floor(time/1000)*1000;
}
// Local hour of day (0–23) of `time` in `timeZone`.
export function zoneHour(time,timeZone=LOCAL_TIME_ZONE){
 return Math.floor(((time+zoneOffsetMs(time,timeZone))%DAY_MS+DAY_MS)%DAY_MS/3600000);
}
// `time` moved forward by `days` calendar days: the same wall-clock time in
// `timeZone`, `days` later. When the target wall-clock time falls into a DST
// transition, the offset in effect before the transition is used, as
// java.time does: a time inside the spring gap moves forward by the gap
// (02:30 becomes 03:30), a time inside the autumn overlap takes its first
// occurrence. Outside those two hours a year the mapping is strictly monotonic.
export function addCalendarDays(time,days,timeZone=LOCAL_TIME_ZONE){
 if(!days)return time;
 const wall=time+zoneOffsetMs(time,timeZone)+days*DAY_MS;
 const first=zoneOffsetMs(wall-zoneOffsetMs(time,timeZone),timeZone);
 const candidate=wall-first;
 const second=zoneOffsetMs(candidate,timeZone);
 if(first===second)return candidate;
 const before=zoneOffsetMs(Math.min(candidate,wall-second)-1000,timeZone);
 return wall-before;
}

// Whole calendar days that bring `updatedAt` as close to `now` as possible
// without passing it, so the shifted update time is within the last day.
export function shiftDaysToNow(updatedAt,now=Date.now(),timeZone=LOCAL_TIME_ZONE){
 const at=typeof updatedAt==='number'?updatedAt:Date.parse(String(updatedAt??''));
 if(!Number.isFinite(at)||at>now)return 0;
 let days=Math.floor((now-at)/DAY_MS)+1;
 while(days>0&&addCalendarDays(at,days,timeZone)>now)days--;
 return days;
}

// A mapping from original to shifted instants. A number is a fixed offset in
// milliseconds; `{days, timeZone}` is a calendar-day shift.
export function timeMover(shift){
 if(typeof shift==='function')return shift;
 if(typeof shift==='number')return shift?time=>time+shift:null;
 const days=Number(shift?.days)||0;
 if(!days)return null;
 const timeZone=shift.timeZone||LOCAL_TIME_ZONE;
 return time=>addCalendarDays(time,days,timeZone);
}

const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function shiftValue(value,move){
 if(typeof value==='number')return Number.isFinite(value)?move(value):value;
 if(typeof value==='string'&&ISO.test(value)){const time=Date.parse(value);return Number.isNaN(time)?value:new Date(move(time)).toISOString();}
 return value;
}
function shiftFields(object,fields,move){
 if(!object||typeof object!=='object'||Array.isArray(object))return object;
 const out={...object};
 for(const field of fields)if(field in out)out[field]=shiftValue(out[field],move);
 return out;
}
function shiftShows(item,move){
 if(!item||typeof item!=='object'||!Array.isArray(item.shows))return item;
 return {...item,shows:item.shows.map(show=>shiftFields(show,['start','end'],move))};
}
function shiftList(list,move,fields){return Array.isArray(list)?list.map(item=>shiftShows(shiftFields(item,fields,move),move)):list;}

const handlers={
 programme(report,move){
  const out=shiftFields(report,['updatedAt','watchlistUpdatedAt','cutoff'],move);
  if(report.window)out.window=shiftFields(report.window,['from','to'],move);
  if(report.stats)out.stats=shiftFields(report.stats,['epgStart','epgEnd'],move);
  if(Array.isArray(report.films))out.films=shiftList(report.films,move,['availableUntil']);
  return out;
 },
 watchlist(list,move){return shiftFields(list,['updatedAt'],move);},
 sync(state,move){
  const out=shiftFields(state,['startedAt','updatedAt'],move);
  if(Array.isArray(state.events))out.events=state.events.map(event=>shiftFields(event,['at'],move));
  return out;
 },
 discoveryLatest(latest,move){
  const out=shiftFields(latest,['updatedAt'],move);
  if(Array.isArray(latest.items))out.items=shiftList(latest.items,move,['firstAiring','lastAiring']);
  return out;
 },
 discoveredFilms(catalog,move){
  if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))return catalog;
  return Object.fromEntries(Object.entries(catalog).map(([id,film])=>[id,shiftShows(shiftFields(film,['epgLastAiring'],move),move)]));
 },
 // Only programme and watchlist history follows the shifted programme. Prediction
 // runs and started markers keep their real timestamps, and so do their events.
 event(event,move){return event&&(event.type==='epg'||event.type==='watchlist')?shiftFields(event,['at'],move):event;},
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
// `shift` is a fixed millisecond offset, `{days, timeZone}`, or a mover.
export function shiftSnapshotObject(key,json,shift){
 const handler=timeShiftHandler(key);
 const move=timeMover(shift);
 if(!handler||!move||!json||typeof json!=='object')return json;
 return handlers[handler](json,move);
}
