// check-config-examples.mjs — CI guard for ExportedConfig examples in the docs.
//
// Every fenced code block tagged `json title="playbook.json"` in the docs
// is parsed and validated against `ExportedConfigSchema` from @revt-eng/schema.
// A docs example that no longer matches the real schema fails the build, so the
// config JSON readers copy is always valid (run `revturbine verify`-able).
//
// Convention: tag any ExportedConfig example with ```json title="playbook.json".
// Other JSON blocks (decision outputs, partial snippets) are ignored.
//
// Usage: node scripts/check-config-examples.mjs   (run from pages-build/)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ExportedConfigSchema } = require('@revt-eng/schema');

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

// Match ```json ... ``` blocks whose info string carries title="playbook.json".
const BLOCK = /```json[^\n]*\btitle="playbook\.json"[^\n]*\n([\s\S]*?)```/g;

let total = 0;
const failures = [];

for (const file of walk(DOCS)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  let m;
  let i = 0;
  while ((m = BLOCK.exec(src)) !== null) {
    total += 1;
    const where = `${rel} [playbook.json block ${i++}]`;
    let parsed;
    try {
      parsed = JSON.parse(m[1]);
    } catch (e) {
      failures.push(`${where}: JSON parse error — ${e.message}`);
      continue;
    }
    const r = ExportedConfigSchema.safeParse(parsed);
    if (!r.success) {
      const issues = r.error.issues
        .slice(0, 6)
        .map((iss) => `      ${iss.path.join('.') || '(root)'} — ${iss.message}`)
        .join('\n');
      failures.push(`${where}: does not validate against ExportedConfigSchema\n${issues}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} invalid ExportedConfig example(s):\n`);
  for (const f of failures) console.error('  • ' + f);
  console.error(`\nFix the JSON so it validates, or drop the title="playbook.json" tag if it isn't a full config.\n`);
  process.exit(1);
}

console.log(`✓ ${total} ExportedConfig example(s) validate against ExportedConfigSchema.`);
