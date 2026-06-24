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
  },
  format: ['esm'],
  target: 'es2020',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  minify: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
  ],
  // Bundle all internal deps — customers install only @revt-eng/sdk + react
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
