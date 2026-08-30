// check-config-examples.mjs — CI guard for Playbook examples in the docs.
//
// Every fenced code block tagged `json title="revturbine.playbook.json"` in the docs
// is parsed and validated against `PlaybookSchema` from @revt-eng/schema.
// A docs example that no longer matches the real schema fails the build, so the
// Playbook JSON readers copy is always valid with `revturbine validate`.
//
// Convention: tag any complete Playbook example with
// ```json title="revturbine.playbook.json".
// Other JSON blocks (decision outputs, partial snippets) are ignored.
//
// Usage: node scripts/check-config-examples.mjs   (run from pages-build/)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PlaybookSchema } = require('@revt-eng/schema');

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DOCS = join(ROOT, 'src', 'content', 'docs');

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

// Match complete Playbook blocks by their canonical filename.
const BLOCK = /```json[^\n]*\btitle="revturbine\.playbook\.json"[^\n]*\n([\s\S]*?)```/g;

let total = 0;
const failures = [];

for (const file of walk(DOCS)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  let m;
  let i = 0;
  while ((m = BLOCK.exec(src)) !== null) {
    total += 1;
    const where = `${rel} [revturbine.playbook.json block ${i++}]`;
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch (e) {
      failures.push(`${where}: JSON parse error — ${e.message}`);
      continue;
    }
    const r = PlaybookSchema.safeParse(parsed);
    if (!r.success) {
      const issues = r.error.issues
        .slice(0, 6)
        .map((iss) => `      ${iss.path.join('.') || '(root)'} — ${iss.message}`)
        .join('\n');
      failures.push(`${where}: does not validate against PlaybookSchema\n${issues}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} invalid Playbook example(s):\n`);
  for (const f of failures) console.error('  • ' + f);
  console.error(`\nFix the JSON so it validates, or drop the title="revturbine.playbook.json" tag if it isn't a full Playbook.\n`);
  process.exit(1);
}

console.log(`✓ ${total} Playbook example(s) validate against PlaybookSchema.`);
