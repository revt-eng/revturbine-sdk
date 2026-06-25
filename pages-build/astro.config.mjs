import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import starlightTypeDoc from 'starlight-typedoc';
import { join, resolve } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// PAGES_BASE can be set by the deploy workflow.
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
const base = process.env.PAGES_BASE
  ?? (isGithubActions && repoName ? `/${repoName}/` : '/');

// Resolve @revt-eng/* packages from pages-build/node_modules so Vite can find
// them even when the web-sdk/ workspace dependencies use workspace:* protocol.
const pagesNodeModules = resolve(import.meta.dirname, 'node_modules');

// Starlight base-prefixes its own sidebar/asset links, but NOT authored links in
// markdown content or hero `actions` frontmatter — those stay as raw `/getting-started/…`
// and break under any subpath mount (GitHub Pages /revturbine-sdk, or the proxied
// /docs). Post-build, prefix every internal root-absolute href/src that isn't already
// under the base. Base-aware (uses whatever `base` the build ran with), so it fixes
// both the GitHub Pages and the /docs (Vercel) builds. No trailing-slash dependency.
function baseAbsoluteInternalLinks(base) {
  const b = base.replace(/\/+$/, ''); // '/docs' or '/revturbine-sdk' (or '' at root)
  return {
    name: 'base-absolute-internal-links',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        if (!b) return; // nothing to do when served at the root
        const root = fileURLToPath(dir);
        const rewrite = (html) =>
          html.replace(/(href|src)="\/(?!\/)([^"]*)"/g, (m, attr, rest) => {
            const path = '/' + rest;
            if (path === b || path.startsWith(b + '/')) return m; // already based
            return `${attr}="${b}/${rest}"`;
          });
        const walk = async (d) => {
          for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else if (e.name.endsWith('.html'))
              await writeFile(p, rewrite(await readFile(p, 'utf8')));
          }
        };
        await walk(root);
      },
    },
  };
}

export default defineConfig({
  site: 'https://revt-eng.github.io',
  base,
  redirects: {
    '/api/': '/api/readme/',
  },
  vite: {
    resolve: {
      alias: {
        '@revt-eng/core': resolve(pagesNodeModules, '@revt-eng/core'),
        '@revt-eng/schema': resolve(pagesNodeModules, '@revt-eng/schema'),
        '@revt-eng/schema-external': resolve(pagesNodeModules, '@revt-eng/schema-external'),
      },
    },
  },
  integrations: [
    baseAbsoluteInternalLinks(base),
    starlight({
      title: 'RevTurbine SDK',
      description: 'Placement decisioning, entitlement checks, and usage tracking for web applications.',
      logo: {
        src: './public/logo.webp',
        alt: 'RevTurbine',
        replacesTitle: false,
      },
      favicon: '/favicon.png',
      customCss: ['./src/styles/custom.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/revt-eng/revturbine-external' },
      ],
      editLink: {
        baseUrl: 'https://github.com/revt-eng/revturbine-sdk-internal/edit/main/pages-build/',
      },
      head: [
        // OpenGraph defaults
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { property: 'og:site_name', content: 'RevTurbine SDK Docs' } },
        { tag: 'meta', attrs: { property: 'og:image', content: '/logo.webp' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' } },
        { tag: 'meta', attrs: { name: 'twitter:site', content: '@revturbine' } },
      ],
      pagefind: {
        // Pagefind is enabled by default in Starlight; configure ranking
      },
      plugins: [
        starlightTypeDoc({
          entryPoints: ['../web-sdk/index.ts'],
          tsconfig: './tsconfig.typedoc.json',
          typeDoc: {
            skipErrorChecking: true,
            excludePrivate: true,
            excludeProtected: true,
            excludeInternal: true,
            excludeExternals: true,
            excludeNotDocumented: true,
            disableSources: true,
            externalPattern: ['**/node_modules/**'],
          },
          sidebar: {
            label: 'API Reference',
            collapsed: true,
          },
        }),
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Quickstart', slug: 'getting-started/quickstart' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'React Integration', slug: 'getting-started/react' },
            { label: 'Server-Side Integration', slug: 'getting-started/server-side' },
            { label: 'Python SDK', slug: 'getting-started/python' },
          ],
        },
        {
          label: 'Tutorials',
          items: [
            { label: 'Add an Upgrade Button', slug: 'tutorials/upgrade-button' },
            { label: 'Gate a Premium Feature', slug: 'tutorials/gate-premium-feature' },
            { label: 'Track Usage & Quota Meter', slug: 'tutorials/usage-quota-meter' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Runtime Modes', slug: 'guides/runtime-modes' },
            { label: 'Entitlements', slug: 'guides/entitlements' },
            { label: 'Placements', slug: 'guides/placements' },
            { label: 'Custom Slot Types', slug: 'guides/custom-slots' },
            { label: 'Theming', slug: 'guides/theming' },
            { label: 'Events & Analytics', slug: 'guides/events' },
            { label: 'Error Handling', slug: 'guides/error-handling' },
            { label: 'Headless API', slug: 'guides/headless-api' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Provider Architecture', slug: 'concepts/providers' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'Error Codes', slug: 'reference/errors' },
            { label: 'Compatibility Matrix', slug: 'reference/compatibility' },
            { label: 'Changelog', slug: 'reference/changelog' },
          ],
        },
        {
          label: 'Component Gallery',
          items: [
            { label: 'Overview', slug: 'components' },
            { label: 'ButtonSlot', slug: 'components/button-slot' },
            { label: 'BannerSlot', slug: 'components/banner-slot' },
            { label: 'ModalSlot', slug: 'components/modal-slot' },
            { label: 'ToastSlot', slug: 'components/toast-slot' },
            { label: 'QuotaMeterSlot', slug: 'components/quota-meter-slot' },
            { label: 'InlineEmbedSlot', slug: 'components/inline-embed-slot' },
          ],
        },
        {
          label: 'Playground',
          items: [
            { label: 'Overview', slug: 'playground' },
            {
              label: 'Fixed Slots',
              items: [
                { label: 'F-1: Upgrade Button', slug: 'playground/fixed-slots/fixed-button' },
                { label: 'F-2: Plans & Pricing', slug: 'playground/fixed-slots/fixed-in-page' },
                { label: 'F-3: Quota Meter', slug: 'playground/fixed-slots/fixed-usage-counter' },
                { label: 'F-4: Annual Banner', slug: 'playground/fixed-slots/fixed-banner' },
              ],
              collapsed: true,
            },
            {
              label: 'Access Gates',
              items: [
                { label: 'G-1: Data Export Gate', slug: 'playground/access-gates/gate-modal' },
                { label: 'G-2: Branding Gate', slug: 'playground/access-gates/gate-inline' },
                { label: 'G-3: Brand Kit Gate', slug: 'playground/access-gates/gate-card' },
              ],
              collapsed: true,
            },
            {
              label: 'Global Slots',
              items: [
                { label: 'M-1: Usage Warning', slug: 'playground/global-slots/msg-banner' },
                { label: 'M-2: Usage Exhausted', slug: 'playground/global-slots/msg-modal' },
                { label: 'M-3: Trial Toast', slug: 'playground/global-slots/msg-toast' },
              ],
              collapsed: true,
            },
            {
              label: 'Headless API',
              items: [
                { label: 'H-1: PlacementController', slug: 'playground/headless/headless-placement' },
                { label: 'H-2: EntitlementGate', slug: 'playground/headless/headless-gate' },
                { label: 'H-3: SdkSession', slug: 'playground/headless/headless-session' },
              ],
              collapsed: true,
            },
          ],
        },
      ],
    }),
    react(),
  ],
});
