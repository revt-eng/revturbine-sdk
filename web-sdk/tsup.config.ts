import { defineConfig } from 'tsup';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

// `@revt-eng/core`, `@revt-eng/schema`, and `@revt-eng/schema-external` are all
// built from the same upstream source tree (revturbine-scaffold/src/core/), and
// each ships its own pre-built JS with sourcemaps that reference back to the
// shared source files (e.g. scaffold/src/core/common.ts). When rollup tries to
// collate those input sourcemaps into a single output sourcemap, it sees the
// same source path described by multiple inputs with different content
// snapshots and throws "Multiple conflicting contents for sourcemap source ...".
//
// Strip the `//# sourceMappingURL=` comment from bundled-dep JS before esbuild
// reads it. Rollup never sees those input sourcemaps, so collation has nothing
// to conflict on. We still emit sourcemaps for our own (`web-sdk/*.ts`) source,
// which is what actually matters for production debugging.
const stripBundledDepSourceMaps: Plugin = {
  name: 'strip-bundled-dep-sourcemaps',
  setup(build) {
    build.onLoad({ filter: /\.(js|mjs|cjs)$/ }, async (args) => {
      const path = args.path.replace(/\\/g, '/');
      const isBundledDep =
        path.includes('/@revt-eng/') ||
        path.includes('/revturbine-scaffold/') ||
        path.includes('/openapi-fetch/');
      if (!isBundledDep) return null;

      const contents = await readFile(args.path, 'utf8');
      return {
        contents: contents.replace(/\/\/# sourceMappingURL=.*$/gm, ''),
        loader: 'js',
      };
    });
  },
};

export default defineConfig({
  entry: {
    index: 'index.ts',
    headless: 'headless.ts',
    ...(process.env.REVT_SDK_BASE_ONLY === '1'
      ? {}
      : { growthbook: 'growthbook.ts', optimizely: 'optimizely.ts' }),
  },
  outDir: process.env.REVT_SDK_OUT_DIR ?? 'dist',
  format: ['esm'],
  target: 'es2020',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  minify: true,
  clean: true,
  splitting: false,
  // `no-external`: externals (react, crypto) are treated as side-effect-free,
  // so a leftover bare `import 'crypto'` side-effect import is dropped instead
  // of shipping in the browser bundle. Named imports that are actually used
  // (react in index.js) are unaffected. Enforced by check-headless-standalone.
  treeshake: { preset: 'recommended', moduleSideEffects: 'no-external' },
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    // `@revt-eng/core/bundle` bundles the compiler (compile.ts → `node:crypto`
    // `createHash`) alongside the payload helpers in one entry. The SDK only
    // consumes the payload readers (`assertPlaybookPayloadReadable`,
    // `sha256Hex` — WebCrypto) — it never compiles an artifact — so the
    // compiler is dead code here. Marking the node builtin external lets
    // esbuild past the browser-platform resolve of `crypto`; the treeshake
    // setting above then drops the residual side-effect import.
    'crypto',
    'node:crypto',
  ],
  // Bundle all internal deps — customers install only @revturbine/sdk + react
  noExternal: [
    '@revt-eng/schema',
    '@revt-eng/schema-external',
    '@revt-eng/core',
    'openapi-fetch',
  ],
  esbuildPlugins: [stripBundledDepSourceMaps],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
