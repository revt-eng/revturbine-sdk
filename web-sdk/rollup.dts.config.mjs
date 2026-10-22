// Plan 166 TASK-2: bundle the tsc-emitted declaration tree into self-contained
// d.ts files, inlining @revt-eng/* types so the published package type-checks
// with REAL shapes outside the org (no private registry needed). Star
// re-exports from an unresolvable module silently drop every name — this step
// resolves them at build time instead of delegating to the consumer's compiler.
// react/react-dom stay external (peer deps); zod stays external and is a real
// dependency (the schema's types are z.infer<> expressions); posthog-js types
// are consumer-supplied.
import { fileURLToPath } from 'node:url';
import dts from 'rollup-plugin-dts';
import ts from 'typescript';

const external = [
  /^@growthbook\/growthbook($|\/)/,
  /^@optimizely\/optimizely-sdk($|\/)/,
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^zod($|\/)/,
  /^posthog-js($|\/)/,
];

// `web-sdk/generated/*.d.ts` are checked-in generated type sources excluded
// from tsc's declaration emit, so refs to them dangle inside dist/types —
// point them back at the source files for inlining (also fixes the published
// api-client `paths` types, which dangled externally before this step).
const generatedShim = {
  name: 'resolve-generated-dts',
  resolveId(source, importer) {
    if (importer && source.startsWith('./generated/')) {
      return fileURLToPath(new URL(`./generated/${source.slice('./generated/'.length)}.d.ts`, import.meta.url));
    }
    return null;
  },
};

// BUG-711: rollup-plugin-dts drops some template-literal type aliases from
// inlined third-party declarations while keeping their uses. zod-openapi's
// inlined openapi3-ts types use `IExtensionName` as an index-signature key, and
// every shipped entry lost its declaration (TS2304 + TS1268 for customers with
// library checking on). Re-declare an alias a chunk uses but no longer
// declares, verbatim from its source. `check-packed-consumer.mjs` compiles the
// packed result and fails if another alias goes missing.
const DROPPED_TEMPLATE_ALIASES = {
  // zod-openapi dist/components-*.d.mts (openapi3-ts specification-extension).
  IExtensionName: 'type IExtensionName = `x-${string}`;',
};

const restoreDroppedAliases = {
  name: 'restore-dropped-template-aliases',
  renderChunk(code) {
    let next = code;
    for (const [name, declaration] of Object.entries(DROPPED_TEMPLATE_ALIASES)) {
      const used = new RegExp(`\\b${name}\\b`).test(next);
      const declared = new RegExp(`\\btype ${name}\\b`).test(next);
      if (used && !declared) next = `${next}\n${declaration}\n`;
    }
    return next === code ? null : { code: next, map: null };
  },
};

// 0.12.2: every entry ships twice — `<entry>.d.ts` for the `import`
// condition and an identical `<entry>.d.cts` for `require`. The package is
// `"type": "module"`, so TypeScript reads a `.d.ts` as an ES module, and before
// 5.8 it rejects a CommonJS import of one (TS1479) even though Node ≥ 22.13
// `require()`s the ESM build. A `.d.cts` declares the same names as a CommonJS
// module, which is what `require()` of the ESM build returns (its namespace —
// no entry has a default export). Each bundle is self-contained (no relative
// imports), so the copy needs no specifier rewriting.
const entry = (input, file) => ({
  input,
  output: [
    { file, format: 'es' },
    { file: file.replace(/\.d\.ts$/, '.d.cts'), format: 'es' },
  ],
  external,
  plugins: [
    generatedShim,
    dts({
      respectExternal: true,
      // BUG-711: `web-sdk/` has no tsconfig.json, so without these the plugin
      // resolves with node10 semantics, which ignore package `exports`. The
      // root `@revt-eng/core` resolved through `types`, but the subpaths
      // (`@revt-eng/core/bundle`, `/trials`) did not, and their imports were
      // left external — shipping private-package imports to customers (TS2307
      // under skipLibCheck:false). Bundler resolution reads `exports`, so they
      // inline like every other @revt-eng type.
      compilerOptions: {
        preserveSymlinks: false,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
    }),
    // After dts: its own renderChunk rewrites the chunk first.
    restoreDroppedAliases,
  ],
});

export default [
  entry('dist/types/web-sdk/index.d.ts', 'dist/index.d.ts'),
  entry('dist/types/web-sdk/headless.d.ts', 'dist/headless.d.ts'),
  entry('dist/types/web-sdk/growthbook.d.ts', 'dist/growthbook.d.ts'),
  entry('dist/types/web-sdk/optimizely.d.ts', 'dist/optimizely.d.ts'),
];
