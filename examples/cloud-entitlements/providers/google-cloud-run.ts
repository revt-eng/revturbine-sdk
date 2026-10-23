import { createServer } from 'node:http';
import { createLazyHandler } from '../src/config';
import { nodeHttpHandler } from '../src/node-http';
/** Regional Cloud Run server; a CDN does not move SDK evaluation to the edge. */
export const server = createServer(nodeHttpHandler(createLazyHandler(() => process.env)));
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`Listening on port ${address.port}`);
});
