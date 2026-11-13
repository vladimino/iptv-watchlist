// AIR-374 P3: the one routing decision of the canonical producers, in its own module so the producer adapters, the readiness registry and the Worker bundle share it without an import cycle. The readiness registry re-exports it, so every existing import keeps working. Exactly one of the projector and the canonical adapters may write in any state.
import {assertWritable,failed,readAuthority} from './film-person-authority.js';
export async function writerRoute(env){
 const gate=await readAuthority(env);
 if(gate.r2Allowed===true)return {writer:'projector',projector:'writes',canonical:'dormant',state:gate.state,generation:gate.generation};
 if(gate.state==='open')return {writer:'canonical',projector:'compare_only',canonical:'writes',state:gate.state,generation:gate.generation};
 assertWritable(gate); // throws film_person_held / film_person_unavailable
 throw failed('film_person_unavailable');
}
