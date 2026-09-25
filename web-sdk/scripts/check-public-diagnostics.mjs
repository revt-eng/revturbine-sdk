// Plan 254 AC-2/AC-5: exercise installed release bytes and public examples.
// Run after build:sdk. Evidence (including the tarball) stays in test-results.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const webSdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(webSdk, 'package.json'));
const { build } = createRequire(require.resolve('tsup'))('esbuild');
const evidence = resolve(webSdk, '../test-results/public-diagnostics');
const bundles = join(evidence, 'dist');
mkdirSync(bundles, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'revt-diagnostics-'));
const stage = join(scratch, 'package');
const consumer = join(scratch, 'consumer');
mkdirSync(stage);
mkdirSync(consumer);

// Resolve npm's JS entry rather than concatenating shell commands (Windows too).
const npmCommand = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['npm'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const npmRoot = dirname(realpathSync(npmCommand));
const npmCli = [join(npmRoot, 'node_modules/npm/bin/npm-cli.js'), join(npmRoot, 'npm-cli.js')].find(existsSync);
assert.ok(npmCli, `Cannot find npm CLI beside ${npmCommand}`);
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
});

try {
  // Same public metadata changes as revturbine-sdk's release-npm workflow;
  // never change the source manifest or rewrite the built JavaScript.
  const manifest = JSON.parse(readFileSync(join(webSdk, 'package.json'), 'utf8'));
  manifest.name = '@revturbine/sdk';
  manifest.publishConfig = { registry: 'https://registry.npmjs.org', access: 'public' };
  manifest.repository = { ...manifest.repository, type: 'git', url: 'git+https://github.com/revt-eng/revturbine-sdk.git' };
  manifest.homepage = 'https://revt-eng.github.io/revturbine-sdk/';
  manifest.bugs = { url: 'https://github.com/revt-eng/revturbine-sdk/issues' };
  manifest.license = 'MIT';
  delete manifest.scripts;
  writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  cpSync(join(webSdk, 'dist'), join(stage, 'dist'), { recursive: true });
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
    if (existsSync(join(webSdk, file))) cpSync(join(webSdk, file), join(stage, file));
  }
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', evidence], stage));
  assert.ok(packed.files.some(file => file.path === 'CHANGELOG.md'), 'package includes the changelog');
  const tarball = join(evidence, packed.filename);
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(join(evidence, 'package-inventory.json'), JSON.stringify(packed, null, 2));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'diagnostics-consumer', private: true, type: 'module' }));
  writeFileSync(join(consumer, '.npmrc'), 'registry=https://registry.npmjs.org\n');
  const reactVersion = require('react/package.json').version;
  const typescriptVersion = require('typescript/package.json').version;
  const reactTypesVersion = require('@types/react/package.json').version;
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', tarball, `react@${reactVersion}`, `react-dom@${reactVersion}`, `typescript@${typescriptVersion}`, `@types/react@${reactTypesVersion}`], consumer);
  cpSync(join(webSdk, 'scripts/fixtures/public-diagnostics.jsx'), join(consumer, 'entry.jsx'));
  const installed = join(consumer, 'node_modules/@revturbine/sdk');
  assert.equal(readFileSync(join(installed, 'dist/index.js'), 'utf8'), readFileSync(join(webSdk, 'dist/index.js'), 'utf8'));
  assert.equal(readFileSync(join(installed, 'CHANGELOG.md'), 'utf8'), readFileSync(join(webSdk, '../CHANGELOG.md'), 'utf8'), 'installed changelog matches the authoritative source');
  assert.ok(!existsSync(join(consumer, 'node_modules/@revt-eng')), 'consumer must not resolve private packages');

  // Compile the actual public-import TSDoc blocks so the IDE quick starts
  // cannot drift from the installed declarations. No source path aliases.
  const examples = [];
  for (const source of ['index.ts', 'headless.ts', 'customer-side.ts']) {
    const contents = readFileSync(join(webSdk, source), 'utf8');
    for (const match of contents.matchAll(/```ts\r?\n([\s\S]*?)\r?\n\s*\*\s*```/g)) {
      const example = match[1].replace(/^\s*\* ?/gm, '');
      if (!/from ['"]@revturbine\/sdk(?:\/headless)?['"]/.test(example)) continue;
      const filename = `example-${examples.length}.ts`;
      writeFileSync(join(consumer, filename), example);
      examples.push({ source, filename });
    }
  }
  assert.equal(examples.length, 5, 'root, headless and SDK public-import examples are compiled');
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, moduleResolution: 'bundler', module: 'esnext', target: 'es2022', noEmit: true },
    include: ['example-*.ts'],
  }));
  const typecheck = execFileSync(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', consumer], { encoding: 'utf8' });
  writeFileSync(join(evidence, 'public-examples.json'), JSON.stringify({ examples, typecheck, passed: true }, null, 2));
  console.log(`PASS ${examples.length} public TSDoc examples against installed package types`);

  const results = [];
  const browser = await chromium.launch();
  try {
    for (const mode of ['development', 'production', 'raw']) {
      const bundle = await build({
        absWorkingDir: consumer, entryPoints: ['entry.jsx'], bundle: true,
        platform: 'browser', format: 'iife', target: 'es2020', jsx: 'automatic',
        minify: mode === 'production', write: false, metafile: true,
        define: { 'process.env.NODE_ENV': mode === 'raw' ? 'process.env.NODE_ENV' : JSON.stringify(mode) },
        // Raw mode leaves the installed SDK's environment lookup untouched.
        // React's published CJS entry needs its own explicit production choice.
        plugins: mode !== 'raw' ? [] : [{ name: 'raw-react-runtime', setup(api) {
          api.onLoad({ filter: /node_modules[\\/](?:react(?:-dom)?|scheduler)[\\/].*\.js$/ }, ({ path }) => ({
            contents: readFileSync(path, 'utf8').replaceAll('process.env.NODE_ENV', '"production"'), loader: 'js',
          }));
        } }],
      });
      const inputs = Object.keys(bundle.metafile.inputs).map((file) => file.replaceAll('\\', '/'));
      assert.ok(inputs.includes('node_modules/@revturbine/sdk/dist/index.js'), 'consume the installed distribution entry');
      assert.ok(!inputs.some((file) => /@revturbine\/sdk\/.*\.tsx?$/.test(file)), 'no SDK source entry');
      const js = bundle.outputFiles[0].text;
      writeFileSync(join(bundles, `${mode}.js`), js);
      for (const host of mode === 'raw' ? ['localhost', '127.0.0.1', '[::1]', 'app.example.test'] : ['app.example.test']) {
        const page = await browser.newPage();
        const warnings = [], errors = [], pageErrors = [];
        page.on('console', (message) => {
          if (message.type() === 'warning') warnings.push(message.text());
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.route('**/*', (route) => route.fulfill(route.request().url().endsWith('/consumer.js')
          ? { contentType: 'application/javascript', body: js }
          : route.request().resourceType() === 'document'
            ? { contentType: 'text/html', body: '<div id="failed"></div><div id="healthy"></div><script src="/consumer.js"></script>' }
            : { contentType: 'application/json', body: '{}' }));
        await page.goto(`https://${host}/`);
        try {
          await page.waitForFunction(() => globalThis.diagnostics?.failed?.initStatus.ok === false && globalThis.diagnostics?.healthy?.isReady === true && globalThis.diagnostics?.initializers?.length === 2, null, { timeout: 15_000 });
        } catch (cause) {
          throw new Error(`${mode}/${host}: consumer did not initialize; page errors: ${pageErrors.join('; ')}`, { cause });
        }
        const state = await page.evaluate(() => globalThis.diagnostics);
        const banner = await page.locator('[data-revturbine-init-failure="true"]').count();
        const record = { mode, host, state, banner, warnings, errors, pageErrors };
        results.push(record);
        writeFileSync(join(evidence, 'results.json'), JSON.stringify({ version: manifest.version, tarball: basename(tarball), sha256: digest, results }, null, 2));
        assert.deepEqual(pageErrors, [], `${mode}/${host}: browser errors`);
        assert.equal(state.processAbsent, true);
        assert.equal(state.failed.sdkIsNull, true);
        assert.equal(state.failed.initStatus.phase, 'construct');
        assert.match(state.failed.initStatus.message, /missing array "plans"/);
        assert.match(state.failed.initStatus.remediation, /Re-export/);
        assert.ok(errors.some((message) => message.includes('Re-export')), 'required init error reporting survives every mode');
        assert.equal(await page.locator('[data-probe="failed"]').textContent(), 'host child remains visible');
        assert.equal(state.healthy.sdkIsNull, false);
        assert.equal(state.healthy.background, '#0a0a0a');
        assert.equal(state.legacy.source, 'legacy-config');
        assert.equal(state.legacy.branding.theme.colors.background, '#123456');
        assert.equal(banner, mode === 'production' ? 0 : 1, `${mode}/${host}: init banner`);
        assert.equal(warnings.filter((m) => m.includes('RevTurbineThemeProvider is mounted above')).length, mode === 'production' ? 0 : 1, `${mode}/${host}: theme override`);
        assert.equal(warnings.filter((m) => m.includes('config `theme` field is deprecated')).length, mode === 'production' || (mode === 'raw' && host === 'app.example.test') ? 0 : 1, `${mode}/${host}: legacy theme`);
        for (const initializer of state.initializers) {
          assert.equal(initializer.isPromise, true, `${initializer.entry}: async init`);
          assert.equal(initializer.isSession, true, `${initializer.entry}: awaited session`);
          assert.equal(initializer.context.id, 'user_123');
          assert.equal(initializer.context.user_id, 'user_123');
          assert.deepEqual(initializer.context.custom, { region: 'eu' });
          assert.equal(initializer.plan, 'pro');
          assert.ok(initializer.branding.branding.theme, `${initializer.entry}: session.sdk.getBranding()`);
        }
        const contextWarnings = warnings.filter((m) => m.includes('unrecognized user-context key'));
        assert.equal(contextWarnings.length, 2, `${mode}/${host}: only genuine misuse warns`);
        assert.ok(contextWarnings.every((m) => m.includes('key(s): unknownContextKey.')), 'id is never forwarded as context');
        assert.ok(contextWarnings.every((m) => !m.includes('fixture-value')), 'warnings do not expose context values');
        console.log(`PASS ${mode}/${host}: init status, banner, themes, root/headless sessions, context guardrails`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`Public tarball ${manifest.version} sha256=${digest}; evidence: ${evidence}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
