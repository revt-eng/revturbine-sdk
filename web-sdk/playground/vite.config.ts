import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { writeJourneySet } from './dev/journey-writer';

// The playground reads its bundled config from the revturbine-demo-data sibling
// repo (revt-eng/revturbine-demo-data). That path sits outside the playground
// root, so widen Vite's filesystem allow-list to the shared `revt-eng` root —
// which also covers the SDK source the app imports from `../index`.
const revtEngRoot = resolve(import.meta.dirname, '../../../');

/**
 * Dev-only journey persistence (plan 83 TASK-6). The journey manager POSTs a
 * journey set to `/__journeys`; this writes it to `playground/journeys/<id>.json`
 * so authored journeys are committed to the codebase. `apply: 'serve'` keeps it
 * off the production build entirely, and {@link writeJourneySet} validates +
 * confines every write to the journeys directory.
 */
function journeyWriterPlugin(): Plugin {
  const journeysDir = resolve(import.meta.dirname, 'journeys');
  const MAX_BYTES = 256 * 1024;
  return {
    name: 'prism-journey-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__journeys', (req, res, next) => {
        if (req.method !== 'POST') {
          next();
          return;
        }
        let body = '';
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
          body += chunk;
          if (body.length > MAX_BYTES) {
            aborted = true;
            res.statusCode = 413;
            res.end('Payload too large');
            req.destroy();
          }
        });
        req.on('end', () => {
          if (aborted) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.statusCode = 400;
            res.end('Invalid JSON');
            return;
          }
          void writeJourneySet(journeysDir, parsed).then((result) => {
            if (!result.ok) {
              res.statusCode = result.status;
              res.end(result.error);
              return;
            }
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), journeyWriterPlugin()],
  root: import.meta.dirname,
  server: {
    fs: {
      allow: [revtEngRoot],
    },
  },
});
