// BUG-711 consumer fixture — the adapter entry points resolve with their
// declared public peers installed.
import * as growthbook from '@revturbine/sdk/growthbook';
import * as optimizely from '@revturbine/sdk/optimizely';

export const adapterEntries = [Object.keys(growthbook).length, Object.keys(optimizely).length];
