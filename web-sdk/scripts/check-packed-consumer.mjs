#!/usr/bin/env node
/**
 * check-packed-consumer.mjs — prove a customer can compile against the PACKED
 * public package (BUG-711).
 *
 * The internal checks type the SDK through the workspace: private
 * `@revt-eng/*` packages resolve, `skipLibCheck` is on, and nothing installs
 * the tarball a customer installs. 0.11.22 shipped declarations importing
 * `@revt-eng/core/bundle` and `@revt-eng/core/trials` (TS2307 for every
 * customer with library checking on) and omitted named exports of server
 * method types (TS2459), and every internal check stayed green.
 *
 * This script checks the artifact instead:
 *
 *   1. Packs `web-sdk` with the public manifest edits the mirror applies
 *      (`@revturbine/sdk`, scripts and devDependencies dropped), or takes an
 *      already prepared tarball with `--tarball`.
 *   2. Parses every packed `.d.ts` with the TypeScript AST and fails on any
 *      `@revt-eng/*` module reference (imports, exports, `import()` types,
 *      reference directives), on any bare module the manifest does not
 *      declare as a dependency or peer, and on any `exports` target missing
 *      from the tarball.
 *   3. Installs the tarball into an isolated consumer under the OS temp dir
 *      from PUBLIC npm only (an empty npm user config: no private registry,
 *      no credentials, no workspace links, no parent node_modules, no path
 *      aliases or ambient shims), with React and the adapter peers.
 *   4. Compiles positive and negative fixtures with `strict: true` and
 *      `skipLibCheck: false` under Bundler, NodeNext (ESM and CommonJS) and
 *      node10 resolution. Negative fixtures use `@ts-expect-error`, so an
 *      input that silently stops being rejected fails; `IsAny` assertions
 *      fail when a public type widens to `any`.
 *   5. Loads the headless entry in Node through `import()` and `require()`.
 *
 * It prints the package name, version and tarball sha256 it verified.
 *
 *   node web-sdk/scripts/check-packed-consumer.mjs [--tarball <file.tgz>] [--ts <version>] [--keep]
 *
 * Run `pnpm --dir web-sdk run build` first when packing from source.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const webSdk = resolve(here, '..');
const fixtures = join(here, 'packed-consumer-fixtures');

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const keep = args.includes('--keep');
const tsVersion = argValue('--ts') ?? '5.9.3';
let tarball = argValue('--tarball');

const work = mkdtempSync(join(tmpdir(), 'revt-packed-consumer-'));
const failures = [];
const fail = (message) => failures.push(message);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });
  return { status: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function step(message) {
  console.log(`\n=== [packed-consumer] ${message}`);
}

// ── 1. pack ─────────────────────────────────────────────────────────────────
if (!tarball) {
  step('pack web-sdk with the public manifest');
  if (!existsSync(join(webSdk, 'dist', 'index.d.ts'))) {
    console.error('dist/ is not built; run `pnpm --dir web-sdk run build` first.');
    process.exit(2);
  }
  const stage = join(work, 'stage');
  mkdirSync(stage, { recursive: true });
  // The whole dist/: the manifest's `files` decides what ships, exactly as in
  // the public publish (an intermediate dist/types/ once shipped this way).
  cpSync(join(webSdk, 'dist'), join(stage, 'dist'), { recursive: true });
  if (existsSync(join(webSdk, 'CHANGELOG.md'))) cpSync(join(webSdk, 'CHANGELOG.md'), join(stage, 'CHANGELOG.md'));
  const manifest = JSON.parse(readFileSync(join(webSdk, 'package.json'), 'utf8'));
  manifest.name = '@revturbine/sdk';
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = run('npm', ['pack', '--pack-destination', work, '--silent'], { cwd: stage });
  if (packed.status !== 0) {
    console.error(packed.out);
    process.exit(1);
  }
  const name = readdirSync(work).find((entry) => entry.endsWith('.tgz'));
  tarball = join(work, name);
}
tarball = resolve(tarball);
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');

// ── 2. declaration scan ─────────────────────────────────────────────────────
step('scan packed declarations');
const extracted = join(work, 'extracted');
mkdirSync(extracted, { recursive: true });
// A plain relative name: GNU tar reads a `C:` prefix as a remote host, and
// the Windows shell mangles backslashes.
cpSync(tarball, join(work, 'artifact.tgz'));
const untar = run('tar', ['-xzf', '../artifact.tgz'], { cwd: extracted });
if (untar.status !== 0) {
  console.error(untar.out);
  process.exit(1);
}
const pkgRoot = join(extracted, 'package');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
console.log(`artifact: ${pkg.name}@${pkg.version} sha256=${sha256}`);

const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
const packageRoot = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);

function declarationFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) declarationFiles(full, out);
    else if (/\.d\.[cm]?ts$/.test(entry)) out.push(full);
  }
  return out;
}

function moduleReferences(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const found = source.typeReferenceDirectives.map((ref) => ref.fileName);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    } else if (ts.isExternalModuleReference(node) && ts.isStringLiteral(node.expression)) {
      found.push(node.expression.text);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      found.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

for (const file of declarationFiles(pkgRoot)) {
  const where = relative(pkgRoot, file).replace(/\\/g, '/');
  for (const specifier of moduleReferences(file)) {
    if (specifier.startsWith('.')) continue;
    if (/^@revt-eng\//.test(specifier)) {
      fail(`${where}: references private module '${specifier}'`);
    } else if (!specifier.startsWith('node:') && !declared.has(packageRoot(specifier))) {
      fail(`${where}: references '${specifier}', which is neither a dependency nor a peer`);
    }
  }
}

function exportTargets(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const nested of Object.values(value)) exportTargets(nested, out);
  return out;
}
for (const [entry, target] of Object.entries(pkg.exports ?? {})) {
  for (const path of exportTargets(target)) {
    if (!existsSync(join(pkgRoot, path))) fail(`exports["${entry}"] -> ${path} is not in the tarball`);
  }
}
for (const key of ['main', 'module', 'types']) {
  if (pkg[key] && !existsSync(join(pkgRoot, pkg[key]))) fail(`"${key}": ${pkg[key]} is not in the tarball`);
}

// ── 3. isolated consumer ────────────────────────────────────────────────────
step(`install the tarball into an isolated consumer (public npm, TypeScript ${tsVersion})`);
const consumer = join(work, 'consumer');
cpSync(fixtures, consumer, { recursive: true });
const peers = pkg.devDependencies ?? {};
const consumerManifest = {
  name: 'revt-packed-consumer',
  private: true,
  type: 'module',
  dependencies: {
    '@revturbine/sdk': `file:${tarball.replace(/\\/g, '/')}`,
    react: '^19.0.0',
    'react-dom': '^19.0.0',
    '@types/react': '^19.0.0',
    '@types/react-dom': '^19.0.0',
    '@types/node': '^22.0.0',
    '@growthbook/growthbook': peers['@growthbook/growthbook'] ?? '^1.7.0',
    '@optimizely/optimizely-sdk': peers['@optimizely/optimizely-sdk'] ?? '^6.5.0',
    typescript: tsVersion,
  },
};
writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(consumerManifest, null, 2)}\n`);
const emptyUserConfig = join(work, 'empty-npmrc');
writeFileSync(emptyUserConfig, '');
const install = run('npm', ['install', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], {
  cwd: consumer,
  env: { ...process.env, NPM_CONFIG_USERCONFIG: emptyUserConfig, NODE_AUTH_TOKEN: '', npm_config_workspaces: 'false' },
});
if (install.status !== 0) {
  console.error(install.out);
  fail('npm install of the tarball failed');
}

// ── 4. compile ──────────────────────────────────────────────────────────────
const projects = ['tsconfig.bundler.json', 'tsconfig.nodenext.json', 'tsconfig.nodenext-cjs.json', 'tsconfig.node10.json'];
if (install.status === 0) {
  const tsc = join(consumer, 'node_modules', 'typescript', 'bin', 'tsc');
  for (const project of projects) {
    step(`tsc -p ${project}`);
    // Each entry inlines the whole SDK surface (~5 MB of declarations), and the
    // fixtures load all four entries with library checking on: the default
    // 2 GB heap of a CI runner is not enough.
    const compiled = run(process.execPath, ['--max-old-space-size=6144', tsc, '-p', project, '--noEmit'], {
      cwd: consumer,
      shell: false,
    });
    if (compiled.status !== 0) {
      console.error(compiled.out);
      fail(`consumer compile failed: ${project}`);
    } else {
      console.log('ok');
    }
  }

  // ── 5. runtime smoke ──────────────────────────────────────────────────────
  step('load the headless entry in Node (import and require)');
  const loaded = run(process.execPath, ['runtime-smoke.mjs'], { cwd: consumer, shell: false });
  if (loaded.status !== 0) {
    console.error(loaded.out);
    fail('the headless entry did not load in Node');
  } else {
    console.log(loaded.out.trim());
  }
}

if (!keep) rmSync(work, { recursive: true, force: true });
else console.log(`\nkept: ${work}`);

if (failures.length > 0) {
  console.error(`\n[packed-consumer] FAILED for ${pkg.name}@${pkg.version} (sha256 ${sha256}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`\n[packed-consumer] OK ${pkg.name}@${pkg.version} sha256=${sha256}`);
