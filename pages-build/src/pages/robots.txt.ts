import type { APIRoute } from 'astro';

// Dynamic robots.txt so the Sitemap + llms.txt pointers use the origin and base
// the build was actually deployed under (github.io at / vs revturbine.com at /docs),
// instead of a hardcoded host that goes stale on the proxied domain.
export const GET: APIRoute = ({ site }) => {
  const origin = site?.origin ?? 'https://revt-eng.github.io';
  const base = import.meta.env.BASE_URL.replace(/\/$/, ''); // '' at root, '/docs' when mounted
  const body =
    [
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${origin}${base}/sitemap-index.xml`,
      `# LLM-readable index:      ${origin}${base}/llms.txt`,
      `# LLM-readable full text:  ${origin}${base}/llms-full.txt`,
    ].join('\n') + '\n';
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
