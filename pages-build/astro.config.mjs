import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import starlightTypeDoc from 'starlight-typedoc';
import starlightLlmsTxt from 'starlight-llms-txt';
import remarkGfm from 'remark-gfm';
import { join, resolve } from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// PAGES_BASE can be set by the deploy workflow.
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
const base = process.env.PAGES_BASE
  ?? (isGithubActions && repoName ? `/${repoName}/` : '/');

// PAGES_SITE is the public origin the build is served from. It must match the
// deployment host so the generated sitemap, llms.txt, and robots.txt emit
// absolute URLs on the right domain. Defaults to the GitHub Pages origin; the
// Vercel /docs build sets PAGES_SITE=https://revturbine.com (with PAGES_BASE=/docs).
const site = process.env.PAGES_SITE ?? 'https://revt-eng.github.io';

// Resolve @revt-eng/* packages from the isolated pages-build install so Vite
// uses this docs workspace's exact registry pins, not an outer workspace tree.
const pagesNodeModules = resolve(import.meta.dirname, 'node_modules');

// The Sandpack playground sandboxes install the real, published `@revturbine/sdk`
// from npm. Pin them to the same version the sibling web-sdk source declares, so
// the docs demos always match the SDK the docs describe. Read at config-eval time
// and expose to client code via Vite `define` (see the vite block below).
const sdkVersion = JSON.parse(
  await readFile(resolve(import.meta.dirname, '../web-sdk/package.json'), 'utf8'),
).version;

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
        const prefix = (p) =>
          p === b || p.startsWith(b + '/') ? null : b + p; // null = already based
        const rewrite = (html) =>
          html
            // href/src links
            .replace(/(href|src)="(\/(?!\/)[^"]*)"/g, (m, attr, p) => {
              const np = prefix(p);
              return np ? `${attr}="${np}"` : m;
            })
            // meta-refresh redirect targets, e.g. <meta http-equiv="refresh"
            // content="0;url=/api/readme/"> (Astro `redirects` destinations aren't
            // base-prefixed, so they'd 404 under a subpath mount)
            .replace(/(content="\d+;\s*url=)(\/(?!\/)[^"]*)"/gi, (m, pre, p) => {
              const np = prefix(p);
              return np ? `${pre}${np}"` : m;
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
  site,
  base,
  // MDX does not inherit Astro's `gfm` shorthand, so `.mdx` pages lose GFM
  // tables (plus strikethrough, task lists, autolinks) that `.md` pages get for
  // free — which rendered every `.mdx` table as raw `| … |` text. Register
  // remark-gfm explicitly so it applies to both `.md` and `.mdx`.
  markdown: {
    remarkPlugins: [remarkGfm],
  },
  redirects: {
    '/api/': '/api/readme/',
  },
  vite: {
    define: {
      'import.meta.env.PUBLIC_SDK_VERSION': JSON.stringify(sdkVersion),
    },
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
        // Auto-generates /llms.txt (curated index), /llms-full.txt (all docs as a
        // single markdown file), and /llms-small.txt from the actual page content —
        // so they never drift from the docs the way a hand-maintained file does.
        starlightLlmsTxt({
          projectName: 'RevTurbine SDK',
          description:
            'Placement decisioning, entitlement checks, and usage tracking for web applications.',
          details:
            'RevTurbine is the monetization engine for product-led SaaS: show upgrade ' +
            'prompts, gate features, enforce usage limits, and run the full decision ' +
            'engine client-side with no backend.',
          // Emit the raw markdown source rather than rendering each page through the
          // plugin's Astro container. Required because ~20 docs pages (components/*,
          // playground/*) embed slot-gallery / Sandpack React components via
          // `client:only="react"`, and the plugin's container only registers the
          // astro:jsx renderer — so rendering them throws NoMatchingRenderer and
          // fails the whole /llms-full.txt route. rawContent skips that render pass.
          // Trade-off: llms-full/llms-small carry raw MDX (import lines, JSX tags)
          // instead of cleaned markdown. See the plugin's rawContent option docs.
          rawContent: true,
        }),
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
            { label: 'Recommended API Path', slug: 'getting-started/api-overview' },
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
            { label: 'Show a Banner Placement', slug: 'tutorials/banner-placement' },
            { label: 'Gate a Premium Feature', slug: 'tutorials/gate-premium-feature' },
            { label: 'Track Usage & Quota Meter', slug: 'tutorials/usage-quota-meter' },
            { label: 'Warn About Low Credits', slug: 'tutorials/low-credits-warning' },
            { label: 'Trial-Ending Countdown', slug: 'tutorials/trial-ending-nudge' },
            { label: 'Recover a Failed Payment', slug: 'tutorials/payment-recovery' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Replace Plan Checks', slug: 'guides/migrate-plan-checks' },
            { label: 'Runtime Modes', slug: 'guides/runtime-modes' },
            { label: 'Entitlements', slug: 'guides/entitlements' },
            { label: 'Placements', slug: 'guides/placements' },
            { label: 'Custom Slot Types', slug: 'guides/custom-slots' },
            { label: 'Theming', slug: 'guides/theming' },
            { label: 'Events & Analytics', slug: 'guides/events' },
            { label: 'Run an Experiment', slug: 'guides/experiments' },
            { label: 'Error Handling', slug: 'guides/error-handling' },
            { label: 'Headless API', slug: 'guides/headless-api' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Core Concepts', slug: 'concepts/core-concepts' },
            { label: 'Client vs Server Enforcement', slug: 'concepts/enforcement' },
            { label: 'What Owns What', slug: 'concepts/source-of-truth' },
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
