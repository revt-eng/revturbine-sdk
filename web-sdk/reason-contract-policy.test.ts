import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('reason baseline changelog policy', () => {
  it('the real public-api CLI rejects a baseline edit without a changelog entry', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'revt-reason-policy-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8' }).trim();
    const commit = (message: string) => git('-c', 'user.name=Reason contract fixture', '-c',
      'user.email=reason-contract@example.test', 'commit', '-qm', message);
    try {
      for (const dir of ['scripts', 'web-sdk', 'tests']) mkdirSync(join(scratch, dir));
      copyFileSync(new URL('../scripts/public-api-changelog.mjs', import.meta.url), join(scratch, 'scripts/public-api-changelog.mjs'));
      writeFileSync(join(scratch, 'web-sdk/sample.ts'), '/** @public */\nexport function sample(): string { return "ok"; }\n');
      writeFileSync(join(scratch, 'tests/reason-contract.json'), '{"schema":1,"entitlement":["original"],"placement":[]}\n');
      writeFileSync(join(scratch, 'CHANGELOG.md'), '# Changelog\n');
      git('init', '--quiet');
      execFileSync(process.execPath, ['scripts/public-api-changelog.mjs'], { cwd: scratch });
      git('add', 'scripts/public-api-changelog.mjs', 'web-sdk/sample.ts', 'web-sdk/generated/public-api.json', 'tests/reason-contract.json', 'CHANGELOG.md');
      commit('fixture baseline');
      const base = git('rev-parse', 'HEAD');
      const check = () => spawnSync(process.execPath, ['scripts/public-api-changelog.mjs', '--check', '--base', base], {
        cwd: scratch, encoding: 'utf8',
      });
      expect(check().status).toBe(0);
      writeFileSync(join(scratch, 'tests/reason-contract.json'), '{"schema":1,"entitlement":["renamed"],"placement":[]}\n');
      git('add', 'tests/reason-contract.json');
      commit('rename reason without migration record');
      const rejected = check();
      expect(rejected.status, rejected.stdout + rejected.stderr).toBe(1);
      expect(rejected.stderr).toContain('tests/reason-contract.json');
      expect(rejected.stderr).toContain('CHANGELOG.md');

      writeFileSync(join(scratch, 'CHANGELOG.md'), '# Changelog\n\nIntentional original → renamed reason migration, with a proving test.\n');
      git('add', 'CHANGELOG.md');
      commit('document intentional migration');
      expect(check().status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
