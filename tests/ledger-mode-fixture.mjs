// Isolated ledger-mode fixture for offline tests of full/frozen (ADR 0156, ADR 0160). Production env has no `offlineLedgerFixture`
// and ignores DISCOVERY_LEDGER_MODE. The marker exists only on an offline fixture env; the retired diagnostic canary no longer shares it.
export const LEDGER_FIXTURE_MARKER=Object.freeze({domain:'offline-fixture'});
export function withLedgerMode(env,mode){
 if(!mode)return env;
 return {...env,offlineLedgerFixture:LEDGER_FIXTURE_MARKER,DISCOVERY_LEDGER_MODE:mode};
}
