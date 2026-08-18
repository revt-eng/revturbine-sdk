/**
 * Regenerate the Rust FlatBuffer bindings for the rule-bundle wire format.
 *
 * Mirrors `server-python/scripts/gen-fb.mjs` and scaffold's own `gen-fb.mjs`.
 * The `.fbs` source of truth lives in revturbine-scaffold; this emits the Rust
 * bindings into `server-rust/src/bundle.rs` so the Rust `.rvtb` decoder
 * (plan 185 TASK-9) can read a bundle. Committed to the repo — CI does not run
 * flatc.
 *
 * flatc resolution order: $FLATC, then the scaffold-vendored
 * `<scaffold>/.flatc/flatc[.exe]`, then `flatc` on PATH. flatc MUST match the
 * `flatbuffers` crate major (both 25.x here) — a mismatch is a silent
 * wire-format decode failure, not a build error, so the version is asserted
 * below rather than assumed.
 *
 * Scaffold location: $REVTURBINE_SCAFFOLD_DIR, else the sibling
 * `../../revturbine-scaffold` (the workspace layout). The env var matters when
 * working from a git worktree, where the sibling path does not resolve.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..'); // server-rust/
const SCAFFOLD = path.resolve(
  process.env.REVTURBINE_SCAFFOLD_DIR || path.join(ROOT, '..', '..', 'revturbine-scaffold'),
);
const FBS = path.join(SCAFFOLD, 'src', 'core', 'bundle', 'rule_bundle.fbs');
const OUT_DIR = path.join(ROOT, 'src');
const OUT_FILE = path.join(OUT_DIR, 'bundle.rs');

/** Must match the `flatbuffers` crate major in Cargo.toml. */
const EXPECTED_FLATC_MAJOR = '25';

function fail(msg) {
  console.error(`[gen-fb] ERROR: ${msg}`);
  process.exit(1);
}

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
  fail('flatc not found. Set $FLATC or vendor scaffold/.flatc/flatc.');
}

if (!existsSync(FBS)) {
  fail(
    `rule_bundle.fbs not found at ${FBS}. Set REVTURBINE_SCAFFOLD_DIR or check ` +
      `revturbine-scaffold out as a sibling.`,
  );
}

const flatc = resolveFlatc();
const version = execFileSync(flatc, ['--version']).toString().trim();
console.log(`[gen-fb] using ${flatc} (${version})`);

const major = (version.match(/(\d+)\./) || [])[1];
if (major !== EXPECTED_FLATC_MAJOR) {
  fail(
    `flatc major ${major} does not match the flatbuffers crate major ` +
      `${EXPECTED_FLATC_MAJOR} pinned in Cargo.toml. A mismatch decodes ` +
      `silently wrong rather than failing to build — refusing to generate.`,
  );
}

const tmp = mkdtempSync(path.join(tmpdir(), 'revt-fbrs-'));
try {
  execFileSync(flatc, ['--rust', '-o', tmp, FBS], { stdio: 'inherit' });

  // flatc --rust emits `<stem>_generated.rs` for the schema.
  const emitted = readdirSync(tmp).filter((f) => f.endsWith('.rs'));
  if (emitted.length !== 1) {
    fail(`expected exactly one generated .rs, got: ${emitted.join(', ') || '(none)'}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  cpSync(path.join(tmp, emitted[0]), OUT_FILE);
  console.log(`[gen-fb] regenerated Rust bindings into src/${path.basename(OUT_FILE)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
