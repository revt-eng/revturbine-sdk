// Plan 179 TASK-2 (claim A3): `@revturbine/sdk/headless` must be importable in
// a project with NO react installed. React is an optional peer, so npm never
// auto-installs it — any static react import in the headless bundle is a
// customer-facing crash (ERR_MODULE_NOT_FOUND), exactly what shipped in
// 0.2.68–0.2.72. Packs the SDK, installs the tarball in an isolated temp
// project, and:
//   1. statically asserts dist/headless.js carries no react or crypto import
//      (`import "crypto"` breaks browser bundlers even where Node tolerates it);
//   2. dynamically imports ./headless with react absent (the A3 repro);
//   3. with react added, imports the React entry and asserts the default
//      registry resolves a builtin slot — guards the install-builtins seed
//      against tree-shake regressions.
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webSdk = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

const headlessJs = readFileSync(join(webSdk, 'dist', 'headless.js'), 'utf8');
const banned = [
  /from\s*["']react["']/,
  /import\s*["']react["']/,
  /require\(\s*["']react["']\s*\)/,
  /["']react\/jsx(?:-dev)?-runtime["']/,
  /import\s*["'](?:node:)?crypto["']/,
  /from\s*["'](?:node:)?crypto["']/,
];
for (const re of banned) {
  if (re.test(headlessJs)) {
    console.error(`FAIL: dist/headless.js matches banned import pattern ${re}`);
    process.exit(1);
  }
}
console.log('static scan OK: dist/headless.js has no react/crypto imports');

const dir = mkdtempSync(join(tmpdir(), 'revt-headless-standalone-'));
try {
  const tarball = run(
    `npm pack --pack-destination "${dir}" --json | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d)[0].filename))"`,
    webSdk,
  );
  run('npm init -y', dir);
  run(`npm install "${join(dir, tarball)}" --no-audit --no-fund`, dir);

  writeFileSync(
    join(dir, 'probe-headless.mjs'),
    `await import('@revt-eng/sdk/headless');\nconsole.log('headless import OK without react');\n`,
  );
  run('node probe-headless.mjs', dir);
  console.log('runtime probe OK: ./headless imports with no react installed');

  run('npm install react react-dom --no-audit --no-fund', dir);
  writeFileSync(
    join(dir, 'probe-react.mjs'),
    [
      `const sdk = await import('@revt-eng/sdk');`,
      `const registry = sdk.getDefaultRegistry();`,
      `const slot = registry.resolve({ surface: { type: 'banner' } });`,
      `if (!slot) { console.error('FAIL: default registry not seeded with builtins on the React entry'); process.exit(1); }`,
      `console.log('react entry OK: default registry seeded (resolved ' + slot.id + ')');`,
    ].join('\n'),
  );
  run('node probe-react.mjs', dir);
  console.log('runtime probe OK: React entry seeds the default registry');
} catch (err) {
  console.error('FAIL: headless standalone check');
  if (err.stdout) console.error(String(err.stdout));
  if (err.stderr) console.error(String(err.stderr));
  throw err;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
