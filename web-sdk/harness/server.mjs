import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const harnessRoot = __dirname;

/**
 * Start the SDK local harness development server.
 *
 * This server hosts a standalone harness UI that initializes the customer SDK
 * in `local_only` mode for deterministic developer debugging and Playwright tests.
 */
export async function startSdkLocalHarnessServer(options = {}) {
  const {
    host = '127.0.0.1',
    port = 4174,
    strictPort = true,
    open = false,
    logLevel = 'info',
  } = options;

  const server = await createServer({
    root: harnessRoot,
    configFile: resolve(harnessRoot, 'vite.config.ts'),
    logLevel,
    server: {
      host,
      port,
      strictPort,
      open: open ? '/index.html' : false,
    },
  });

  await server.listen();

  const resolvedHost = typeof host === 'string' ? host : '127.0.0.1';
  const harnessUrl = `http://${resolvedHost}:${port}/index.html`;

  return {
    host: resolvedHost,
    port,
    url: harnessUrl,
    viteServer: server,
    async close() {
      await server.close();
    },
  };
}

export async function runSdkLocalHarnessServerFromCli() {
  const host = process.env.RT_HARNESS_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.RT_HARNESS_PORT || '4174', 10);

  const instance = await startSdkLocalHarnessServer({
    host,
    port: Number.isFinite(port) ? port : 4174,
    open: process.env.RT_HARNESS_OPEN === '1',
  });

  console.log(`[sdk-local-harness] running at ${instance.url}`);

  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
