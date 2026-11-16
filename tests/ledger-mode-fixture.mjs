// Isolated ledger-mode fixture for offline tests of full/frozen (ADR 0155). Production env has no `epgDiagnostic`
// and ignores DISCOVERY_LEDGER_MODE. A truthy `epgDiagnostic` is the same marker the diagnostic canary uses.
export const LEDGER_FIXTURE_DIAGNOSTIC=Object.freeze({domain:'offline-fixture',resourceId:'offline-fixture'});
export function withLedgerMode(env,mode){
 if(!mode)return env;
 return {...env,epgDiagnostic:LEDGER_FIXTURE_DIAGNOSTIC,DISCOVERY_LEDGER_MODE:mode};
}
