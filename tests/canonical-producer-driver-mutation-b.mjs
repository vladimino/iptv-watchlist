// AIR-374 S4-4: the second half of the mutation check of the dormant producer driver (see tests/canonical-producer-driver-mutation-lib.mjs).
import {runMutationPart} from './canonical-producer-driver-mutation-lib.mjs';
await runMutationPart(1,2);
