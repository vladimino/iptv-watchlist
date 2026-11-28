// AIR-537 slice 3: loads src/d1-enrichment.js, which now holds only the read-only status function of the retired enrichment
// projector (since AIR-690 no route calls it; /api/d1/status is the Film/Person status), into a plain vm context. Replaces the retired projector loader (tests/d1-enrichment-context.mjs) for the tests that only
// need the status.
import fs from 'node:fs';
import vm from 'node:vm';

export function statusContext(){
 const context=vm.createContext({Date,Map,Set,JSON,Object,Number,Promise});
 vm.runInContext(fs.readFileSync('src/d1-enrichment.js','utf8')+'\nglobalThis.status={d1EnrichmentStatus};',context);
 return context.status;
}
