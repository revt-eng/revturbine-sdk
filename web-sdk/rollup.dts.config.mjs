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

const external = [/^react($|\/)/, /^react-dom($|\/)/, /^zod($|\/)/, /^posthog-js($|\/)/];

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

const entry = (input, file) => ({
  input,
  output: { file, format: 'es' },
  external,
  plugins: [
    generatedShim,
    dts({
      respectExternal: true,
      compilerOptions: { preserveSymlinks: false },
    }),
  ],
});

export default [
  entry('dist/types/web-sdk/index.d.ts', 'dist/index.d.ts'),
  entry('dist/types/web-sdk/headless.d.ts', 'dist/headless.d.ts'),
  entry('dist/types/web-sdk/server/index.d.ts', 'dist/server.d.ts'),
];
