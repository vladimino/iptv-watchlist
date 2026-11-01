// Registered Worker feature flags and their owner-only readout (AIR-233, ADR 0039).
// The registry is the allowlist: the readout reads exactly these env bindings by name and never enumerates env.
// A raw value leaves the Worker only when it is made of the flag's own known tokens; anything else (a typo, a pasted
// secret, a JSON value) is reported by shape only. The effective mode is computed by the consumer's own function, so
// the readout cannot disagree with what the code does.
const FEATURE_FLAG_REGISTRY_VERSION=1;
const FEATURE_FLAG_RAW_MAX=200;
const onOff=(name,effective,extra={})=>({name,modes:['off','on'],default:'off',tokens:['off','on'],effective,...extra});
const FEATURE_FLAGS=[
 onOff('CANDIDATE_DISCOVERY',env=>candidateDiscoveryMode(env),{trims:true}),
 {name:'LIFECYCLE_LOCALIZATION',modes:['off','shadow','on'],default:'off',tokens:['on:metadata','shadow:metadata'],retiredTokens:['on:epg','on:programme','on:watchlist','shadow:epg','shadow:programme','shadow:watchlist'],list:true,effective:env=>metadataLocalizationMode(env),scope:'metadata'},
 {name:'DISCOVERY_LEDGER_MODE',modes:['full','bounded','frozen'],default:'full',tokens:['full','bounded','frozen'],effective:env=>discoveryLedgerMode(env),note:'full acts as frozen once epg/discovery-archive/v1/ exists; this readout does not read storage'},
 onOff('REMOVAL_RATING_LOOKUP',env=>removalLookupEnabled(env)?'on':'off'),
 // Retired: Diary page 1 on a migrated ratings run does not read this binding (ADR 0075).
 {name:'LETTERBOXD_DIARY_HISTORY',modes:[],default:null,tokens:['off','on'],retired:true,effective:()=>null},
 {name:'D1_ENRICHMENT_WRITE',modes:['off','dry','on'],default:'off',tokens:['off','dry','on'],effective:env=>d1EnrichmentMode(env),note:'AIR-275 phase 2: dry logs the D1 diff without writing; on writes changed Films and Persons from a cron trigger'},
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
 if(flag.trims&&flag.tokens.includes(value.trim()))return null;
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
