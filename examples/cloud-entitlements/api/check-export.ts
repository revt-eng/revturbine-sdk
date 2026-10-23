import { createLazyHandler } from '../src/config';
/** Standalone Vercel Edge Function; never import Node provider adapters here. */
export const config = { runtime: 'edge' };
export default createLazyHandler(() => process.env);
