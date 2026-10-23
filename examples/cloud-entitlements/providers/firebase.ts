import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { createLazyHandler } from '../src/config';
import { nodeHttpHandler } from '../src/node-http';
const apiKey = defineSecret('REVTURBINE_API_KEY');
const handle = nodeHttpHandler(createLazyHandler(() => ({...process.env, REVTURBINE_API_KEY:apiKey.value()})));
/** Firebase Hosting rewrites invoke this regional Gen 2 function. */
export const checkExport = onRequest({region:'us-central1', secrets:[apiKey], cors:false}, handle);
