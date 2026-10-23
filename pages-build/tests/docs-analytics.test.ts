import { describe, expect, it } from 'vitest';
import { docsAnalyticsEnabled } from '../src/lib/docs-analytics';

describe('docs production analytics', () => {
  const production = { VERCEL_ENV: 'production', PAGES_SITE: 'https://revturbine.com', PAGES_BASE: '/docs' };
  it('enables the canonical production mount with optional trailing slashes', () => {
    expect(docsAnalyticsEnabled(production)).toBe(true);
    expect(docsAnalyticsEnabled({ ...production, PAGES_SITE: `${production.PAGES_SITE}/`, PAGES_BASE: '/docs/' })).toBe(true);
  });
  it.each([
    {},
    { ...production, VERCEL_ENV: 'preview' },
    { ...production, VERCEL_ENV: undefined },
    { ...production, PAGES_SITE: 'https://revt-eng.github.io' },
    { ...production, PAGES_SITE: 'https://revturbine.com.attacker.example' },
    { ...production, PAGES_SITE: 'http://revturbine.com' },
    { ...production, PAGES_BASE: '/revturbine-sdk' },
  ])('does not collect from other environments: %j', (env) => {
    expect(docsAnalyticsEnabled(env)).toBe(false);
  });
  const publisher = { PAGES_SITE: 'https://revturbine.com', PAGES_BASE: '/docs/',
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'revt-eng/revturbine-sdk',
    GITHUB_WORKFLOW: 'Deploy docs to Vercel (/docs origin)', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' };
  it('supports the real public publisher that builds before vercel deploy --prod', () => {
    expect(docsAnalyticsEnabled(publisher)).toBe(true);
    expect(docsAnalyticsEnabled({ ...publisher, GITHUB_EVENT_NAME: 'workflow_dispatch' })).toBe(true);
  });
  it.each([
    { ...publisher, GITHUB_WORKFLOW: 'Deploy Pages' },
    { ...publisher, GITHUB_REPOSITORY: 'someone/revturbine-sdk' },
    { ...publisher, GITHUB_REF: 'refs/heads/preview' },
    { ...publisher, GITHUB_EVENT_NAME: 'pull_request' },
    { ...publisher, GITHUB_ACTIONS: undefined },
  ])('rejects other workflow contexts: %j', env => {
    expect(docsAnalyticsEnabled(env)).toBe(false);
  });
});
