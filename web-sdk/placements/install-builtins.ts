// Side-effect module: seeds the default registry with the built-in React slot
// components. Imported by the React entry (index.ts) and PlacementRenderer —
// never from the headless graph, which must not reach the React components.
import { setPlacementRegistrySeed } from './registry';
import { registerBuiltinSlotTypes } from './builtin';

setPlacementRegistrySeed(registerBuiltinSlotTypes);
