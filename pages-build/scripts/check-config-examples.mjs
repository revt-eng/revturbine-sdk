// check-config-examples.mjs — CI guard for Playbook examples in the docs.
//
// Every fenced code block tagged `json title="revturbine.playbook.json"` in the
// docs is checked the way `revturbine validate --offline <file>` checks a file
// (revturbine-cli src/cli.ts, `validate` command):
//
//   1. structural tier — `PlaybookSchema.safeParse` from @revt-eng/schema;
//   2. semantic tier   — `evaluate()` from `@revt-eng/schema/validators`, the
//      shared validator catalog (dangling references, handle uniqueness, trial
//      and placement wiring, ...). The CLI vendors a snapshot of this same
//      module; here we run it straight from the schema version pages-build pins.
//
// A block fails on any `error_draft` or `error_launch` finding — the severities
// that make `revturbine validate` exit non-zero — so the Playbook JSON readers
// copy really is valid with `revturbine validate`. Warnings are ignored, as the
// CLI ignores them for its exit code.
//
// `@revt-eng/schema/validators` ships as TypeScript source, which Node will not
// strip under node_modules, so it is bundled in memory with esbuild into the OS
// temp dir and imported from there (nothing is written into node_modules).
//
// Convention: tag any complete Playbook example with
// ```json title="revturbine.playbook.json".
// Other JSON blocks (decision outputs, partial snippets) are ignored.
//
// Usage: node scripts/check-config-examples.mjs   (run from pages-build/)

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { PlaybookSchema } = require('@revt-eng/schema');

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DOCS = join(ROOT, 'src', 'content', 'docs');

/** The severities that block `revturbine validate` (CLI BLOCKING_SEVERITIES). */
const BLOCKING = new Set(['error_draft', 'error_launch']);

/** Bundle `@revt-eng/schema/validators` (TS source) and import its `evaluate`. */
async function loadEvaluate() {
  const out = await build({
    stdin: {
      contents: "export { evaluate } from '@revt-eng/schema/validators';",
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  const dir = mkdtempSync(join(tmpdir(), 'revt-docs-validators-'));
  const file = join(dir, 'validators.mjs');
  try {
    writeFileSync(file, out.outputFiles[0].text);
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.evaluate !== 'function') {
      throw new Error('@revt-eng/schema/validators did not export evaluate()');
    }
    return mod.evaluate;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Recursively collect .md / .mdx files. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.mdx?$/.test(name)) out.push(p);
  }
  return out;
}

/** One finding as `[severity] RULE at path — message`. */
function formatFinding(f) {
  const t = f.targetRef ?? {};
  const path =
    Array.isArray(t.path) && t.path.length > 0
      ? t.path.join('.')
      : [t.object_type, t.object_id, t.field].filter(Boolean).join('.');
  return `      [${f.severity}] ${f.code}${path ? ` at ${path}` : ''} — ${f.message}`;
}

const evaluate = await loadEvaluate();

// Match complete Playbook blocks by their canonical filename.
const BLOCK = /```json[^\n]*\btitle="revturbine\.playbook\.json"[^\n]*\n([\s\S]*?)```/g;

let total = 0;
const failures = [];

for (const file of walk(DOCS)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  let m;
  let i = 0;
  while ((m = BLOCK.exec(src)) !== null) {
    total += 1;
    const line = src.slice(0, m.index).split('\n').length;
    const where = `${rel}:${line} [revturbine.playbook.json block ${i++}]`;
    let raw;
    try {
      raw = JSON.parse(m[1]);
    } catch (e) {
      failures.push(`${where}: JSON parse error — ${e.message}`);
      continue;
    }
    // Same shape as the CLI: semantic rules only ever see a structurally
    // parsed graph; a parse failure passes just the Zod errors through.
    const parsed = PlaybookSchema.safeParse(raw);
    const findings = evaluate(parsed.success ? parsed.data : {}, {
      structuralErrors: parsed.success ? undefined : parsed.error,
    });
    const blocking = findings.filter((f) => BLOCKING.has(f.severity));
    if (blocking.length > 0) {
      failures.push(
        `${where}: ${blocking.length} blocking finding(s) from revturbine validate's catalog\n` +
          blocking.map(formatFinding).join('\n'),
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} invalid Playbook example(s):\n`);
  for (const f of failures) console.error('  • ' + f);
  console.error(
    `\nFix the JSON so \`revturbine validate --offline\` passes, or drop the title="revturbine.playbook.json" tag if it isn't a full Playbook.\n`,
  );
  process.exit(1);
}

console.log(`✓ ${total} Playbook example(s) pass PlaybookSchema + the revturbine validate catalog.`);
