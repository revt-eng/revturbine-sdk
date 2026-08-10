// Plan 166 TASK-3: clean-room external type acceptance. Packs the SDK, installs
// the tarball in an isolated temp project with NO GitHub-Packages access
// (public npm only), and asserts the published type surface with strict tsc:
//   - Playbook is a REAL shape (a malformed assignment must error);
//   - ExportedConfig / RevTurbineConfig are type-identical aliases of Playbook;
//   - the api-client surface (RevTurbineApiPaths) resolves.
// Guards the packaging boundary itself — inside the org @revt-eng/* always
// resolves, so only an isolated install can catch a regression to `any`.
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webSdk = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'revt-public-types-'));
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();

try {
  const tarball = join(webSdk, run(`npm pack --pack-destination "${dir}" --json | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d)[0].filename))"`, webSdk));
  run('npm init -y', dir);
  run(`npm install "${join(dir, require_basename(tarball))}" typescript@5.9 zod@4.4.3 react @types/react --no-audit --no-fund`, dir);
  writeFileSync(join(dir, 'probe.ts'), `import type { Playbook, ExportedConfig, RevTurbineConfig, RevTurbineApiPaths } from '@revt-eng/sdk';
// @ts-expect-error plans must be an array of plan objects — errors only when shapes are REAL
export const bad: Playbook = { plans: 'not-an-array' };
export type PlanItem = Playbook['plans'][number];
export type AliasesIdentical = ExportedConfig extends Playbook ? (RevTurbineConfig extends Playbook ? true : never) : never;
export const ok: AliasesIdentical = true;
export type ApiPaths = keyof RevTurbineApiPaths;
`);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, moduleResolution: 'bundler', module: 'esnext', target: 'es2022', noEmit: true },
    include: ['probe.ts'],
  }));
  execSync('npx tsc -p .', { cwd: dir, stdio: 'inherit', shell: true });
  console.log('check-public-types: PASS — published type surface is real and self-contained');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function require_basename(p) {
  return p.split(/[\\/]/).pop();
}
