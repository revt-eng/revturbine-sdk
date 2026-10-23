import { createLazyHandler } from '../src/config';
import { nodeHttpHandler } from '../src/node-http';
/** Vercel Node Function using the same authenticated operation as the Edge entry. */
export default nodeHttpHandler(createLazyHandler(() => process.env));
