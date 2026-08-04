/**
 * Regenerate the Python FlatBuffer bindings for the rule-bundle wire format.
 *
 * Mirrors scaffold's `scripts/gen-fb.mjs`. The `.fbs` source of truth lives in
 * revturbine-scaffold; this emits the Python bindings into
 * `src/revturbine/bundle/` so the Python `.rvtb` decoder (plan 160 TASK-4) can
 * read a bundle. Committed to the repo — CI does not run flatc.
 *
 * flatc resolution order: $FLATC, then the scaffold-vendored
 * `../../revturbine-scaffold/.flatc/flatc[.exe]`, then `flatc` on PATH. flatc
 * MUST match the `flatbuffers` runtime major (both 25.x here).
 *
 * IMPORTANT: `flatc -o src` would clobber `src/revturbine/__init__.py` (flatc
 * emits an `__init__.py` per namespace dir). So we generate into a temp dir and
 * copy ONLY the `revturbine/bundle/` subtree into place.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..'); // server-python/
const SCAFFOLD = path.join(ROOT, '..', '..', 'revturbine-scaffold');
const FBS = path.join(SCAFFOLD, 'src', 'core', 'bundle', 'rule_bundle.fbs');
const OUT = path.join(ROOT, 'src', 'revturbine', 'bundle');

function resolveFlatc() {
  const candidates = [
    process.env.FLATC,
    path.join(SCAFFOLD, '.flatc', process.platform === 'win32' ? 'flatc.exe' : 'flatc'),
    process.platform === 'win32' ? 'flatc.exe' : 'flatc',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try next */
    }
  }
  console.error('[gen-fb] flatc not found. Set $FLATC or vendor scaffold/.flatc/flatc.');
  process.exit(1);
}

const flatc = resolveFlatc();
const version = execFileSync(flatc, ['--version']).toString().trim();
console.log(`[gen-fb] using ${flatc} (${version})`);

const tmp = mkdtempSync(path.join(tmpdir(), 'revt-fbpy-'));
try {
  execFileSync(flatc, ['--python', '--python-typing', '-o', tmp, FBS], { stdio: 'inherit' });
  // Copy only the bundle namespace subtree — NOT the top-level revturbine/
  // __init__.py flatc emits, which would clobber the real package init.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(path.join(tmp, 'revturbine', 'bundle'), OUT, { recursive: true });
  const init = path.join(OUT, '__init__.py');
  if (!existsSync(init)) writeFileSync(init, '');
  console.log(`[gen-fb] regenerated Python bindings into src/revturbine/bundle`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
