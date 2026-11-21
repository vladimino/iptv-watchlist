// Registered Worker feature flags and their owner-only readout (AIR-233, ADR 0039).
// The registry is the allowlist: the readout reads exactly these env bindings by name and never enumerates env.
// A raw value leaves the Worker only when it is made of the flag's own known tokens; anything else (a typo, a pasted
// secret, a JSON value) is reported by shape only. The effective mode is computed by the consumer's own function, so
// the readout cannot disagree with what the code does.
const FEATURE_FLAG_REGISTRY_VERSION=1;
const FEATURE_FLAG_RAW_MAX=200;
const FEATURE_FLAGS=[
 {name:'LIFECYCLE_LOCALIZATION',modes:['off','shadow','on'],default:'off',tokens:['on:metadata','shadow:metadata'],retiredTokens:['on:epg','on:programme','on:watchlist','shadow:epg','shadow:programme','shadow:watchlist'],list:true,effective:env=>metadataLocalizationMode(env),scope:'metadata'},
 // Retired (AIR-232 / ADR 0156): production seal is always bounded; leftover bindings are ignored.
 {name:'DISCOVERY_LEDGER_MODE',modes:[],default:null,tokens:['full','bounded','frozen'],retired:true,effective:()=>null,note:'inert; the EPG diagnostic canary still chooses full/frozen/bounded on its isolated env'},
 // Retired (AIR-325): Discovery always runs as the Cloudflare Workflow; the binding is ignored.
 {name:'DISCOVERY_EXECUTOR',modes:[],default:null,tokens:['external','workflow'],retired:true,effective:()=>null},
 // Retired: a migrated ratings run's per-film removal lookup does not read this binding (ADR 0077).
 {name:'REMOVAL_RATING_LOOKUP',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 // Retired: Diary page 1 on a migrated ratings run does not read this binding (ADR 0075).
 {name:'LETTERBOXD_DIARY_HISTORY',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 // Retired (AIR-308, ADR 0155): the hourly cron does not call the projector. The binding is ignored.
 {name:'D1_ENRICHMENT_WRITE',modes:[],default:null,tokens:['off','dry','on'],retired:true,effective:()=>null,note:'AIR-308: retired. A set value, including on, does not start the R2 to D1 Film/Person projector. Removing the Cloudflare binding needs a separate owner approval'},
 // Retired (AIR-512): the production projector is gone. Historical offline projector tests still exercise the helpers.
 {name:'D1_ENRICHMENT_WINDOW',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null,note:'AIR-512: retired. A set value does not request projector_window. Discovery still refuses admission while a held row exists. Removing the Cloudflare binding needs a separate owner approval'},
 {name:'D1_ENRICHMENT_BULK',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null,note:'AIR-512: retired. A set value selects no production write path. Removing the Cloudflare binding needs a separate owner approval'},
 {name:'MONITOR',modes:['off','on'],default:'off',tokens:['off','on'],effective:env=>env?.MONITOR==='on'?'on':'off',note:'AIR-349/AIR-366: the Cloudflare-native monitor, a permanent emergency gate. off stops the tick, alerts and the dead-man heartbeat; on keeps monitor/state.json and sends alerts through the transport MONITOR_TRANSPORT selects, once that channel is configured. Any other value, including the retired dry, is off'},
 // AIR-564 (ADR 0187 decision 5): activation of the Channel policy in the EPG scan. off (the default, also for an absent or malformed value) leaves the scan, the event and the continuity guard exactly as before; on makes every EPG scan read one Channel snapshot and apply deny_all|known_only|discover, and refuses to publish when the snapshot is unavailable, torn or empty. Owner GO only.
 {name:'EPG_CHANNEL_POLICY',modes:['off','on'],default:'off',tokens:['off','on'],effective:env=>env?.EPG_CHANNEL_POLICY==='on'?'on':'off',note:'AIR-564: the Channel policy activation. Deploying changes nothing; the next natural EPG sync after the owner sets on is the first effect. Never infer on from a stored snapshot.'},
 {name:'MONITOR_TRANSPORT',modes:['webhook','telegram'],default:'webhook',tokens:['webhook','telegram'],effective:env=>{const value=env?.MONITOR_TRANSPORT;return value===undefined||value===null||value===''||value==='webhook'?'webhook':value==='telegram'?'telegram':'invalid';},note:'AIR-365: which channel the monitor delivers to. Absent or webhook is the generic JSON webhook; telegram is the Telegram Bot API; any other value is invalid and delivery fails closed. The Telegram bot token (a Worker secret) and chat id (a Worker variable) are not flags and are never registered or read out here'},
 // ADR 0183 (AIR-552), temporary: the read source of the view index. d1 derives the key set and the fields from D1 and never reads the raw R2 object; the raw writers are not behind it.
 {name:'VIEW_INDEX_SOURCE',modes:['r2','d1'],default:'r2',tokens:['r2','d1'],effective:env=>env?.VIEW_INDEX_SOURCE==='d1'?'d1':'r2',note:'ADR 0183: temporary read selector. r2 (the default, also for an absent or malformed value) reads the raw enrichment/view-index.json and lays the D1 overlays over it; d1 derives the key set from prediction_pointer, prediction_fingerprint and ratings_view and never reads the raw object. The raw writers keep writing it, so setting r2 again is the rollback. To be removed with the legacy writers'},
 // Retired: the code ignores the binding whatever it holds. Reported so a stale binding is visible.
 {name:'RATINGS_PIPELINE',modes:[],default:null,tokens:['inline','separate'],retired:true,effective:()=>null},
 {name:'SCORED_RESOLUTION',modes:[],default:null,tokens:['off','shadow','on'],retired:true,effective:()=>null},
 {name:'RATINGS_REFRESH',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'FINDS_TITLE_EXCLUSION',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'FINDS_WATCHED_MARK',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'PREDICTION_PROFILE_COMPATIBILITY',modes:[],default:null,tokens:['strict','selective'],retired:true,effective:()=>null},
 {name:'PREDICTION_VERSION_OBJECTS',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'FINGERPRINT_VERSION_OBJECTS',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'PREDICTION_FINGERPRINT_COMPATIBILITY',modes:[],default:null,tokens:['strict','selective'],retired:true,effective:()=>null},
 {name:'CATALOG_POSTER_HYDRATION',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'PREDICTION_MATERIALIZATION',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'LETTERBOXD_BASELINE_IMPORT',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'LETTERBOXD_FACTS',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
];
const featureFlagNames=()=>FEATURE_FLAGS.map(flag=>flag.name);
function featureFlagRaw(flag,value){
 if(typeof value!=='string')return {raw:null,redacted:true,shape:{type:Array.isArray(value)?'array':value===null?'null':typeof value}};
 const known=[...flag.tokens,...(flag.retiredTokens||[])];
 const parts=flag.list?value.split(','):[value];
 const literal=value.length<=FEATURE_FLAG_RAW_MAX&&parts.every(part=>known.includes(part.trim())||(flag.list&&part.trim()===''));
 return literal?{raw:value,redacted:false,shape:null}:{raw:null,redacted:true,shape:{type:'string',length:value.length}};
}
function featureFlagIssue(flag,value){
 if(value===undefined)return null;
 if(typeof value!=='string')return 'not_string';
 if(flag.list){
  const parts=value.split(',').map(part=>part.trim()).filter(Boolean);
  if(parts.some(part=>!flag.tokens.includes(part)&&!(flag.retiredTokens||[]).includes(part)))return 'unrecognized_tokens';
  if(parts.some(part=>(flag.retiredTokens||[]).includes(part)))return 'retired_tokens';
  return null;
 }
 if(flag.tokens.includes(value))return null;
 return flag.tokens.includes(value.trim().toLowerCase())?'case_or_whitespace':'unrecognized';
}
// One read of the allowlisted bindings. No storage, no fetch, no write. env is read by name only.
function featureFlagReport(env,now=new Date()){
 const flags=FEATURE_FLAGS.map(flag=>{
  const value=env?.[flag.name];
  const state=value===undefined?'absent':'set';
  const raw=value===undefined?{raw:null,redacted:false,shape:null}:featureFlagRaw(flag,value);
  const issue=featureFlagIssue(flag,value);
  const entry={name:flag.name,state,raw:raw.raw,redacted:raw.redacted,...(raw.shape?{shape:raw.shape}:{}),valid:flag.retired?value===undefined:issue===null,issue:flag.retired?(value===undefined?null:'retired'):issue,effective:flag.effective(env||{}),default:flag.default,modes:flag.modes,retired:!!flag.retired};
  if(flag.scope)entry.scope=flag.scope;
  if(flag.note)entry.note=flag.note;
  return {flag,entry};
 });
 const byName=new Map(flags.map(item=>[item.flag.name,item.entry]));
 for(const {flag,entry} of flags){
  if(!flag.requires)continue;
  const unmet=Object.entries(flag.requires).filter(([name,mode])=>byName.get(name)?.effective!==mode).map(([name])=>name);
  entry.requires=flag.requires;
  entry.effectiveWithRequirements=entry.effective===flag.default||!unmet.length?entry.effective:flag.default;
  entry.unmetRequirements=unmet;
 }
 const entries=flags.map(item=>item.entry);
 return {registryVersion:FEATURE_FLAG_REGISTRY_VERSION,source:'worker_env_bindings',readAt:now.toISOString(),flags:entries,summary:{registered:entries.length,set:entries.filter(item=>item.state==='set').length,absent:entries.filter(item=>item.state==='absent').length,invalid:entries.filter(item=>!item.valid).length,redacted:entries.filter(item=>item.redacted).length},storage:'not_accessed',sideEffects:'none'};
}
