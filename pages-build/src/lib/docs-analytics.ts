/** Enable analytics only for the canonical production publisher or Vercel build. */
export function docsAnalyticsEnabled(env: Record<string, string | undefined>): boolean {
  const productionPublisher = env.GITHUB_ACTIONS === 'true'
    && env.GITHUB_REPOSITORY === 'revt-eng/revturbine-sdk'
    && env.GITHUB_WORKFLOW === 'Deploy docs to Vercel (/docs origin)'
    && env.GITHUB_REF === 'refs/heads/main'
    && ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '');
  return (env.VERCEL_ENV === 'production' || productionPublisher)
    && env.PAGES_SITE?.replace(/\/+$/, '') === 'https://revturbine.com'
    && env.PAGES_BASE?.replace(/\/+$/, '') === '/docs';
}

/** Marketing and documentation share this Google Tag Manager container. */
export const docsTagManagerId = 'GTM-PPQQ6S74';
