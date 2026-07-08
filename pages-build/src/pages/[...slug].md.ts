import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

// Serves the raw markdown source of every docs page at `<page-path>.md`
// (e.g. /guides/entitlements.md). Agents get clean, low-token markdown instead
// of having to strip nav chrome out of the rendered HTML. Base-aware: under the
// /docs mount these resolve to /docs/guides/entitlements.md automatically.
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs');
  return docs
    // Skip entries with no raw body (e.g. the landing hero) — the llms.txt index
    // already covers those, and an empty .md file is just noise.
    .filter((entry) => entry.body?.trim() && entry.id !== 'index')
    .map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
};

export const GET: APIRoute = ({ props }) => {
  const { entry } = props as { entry: { data: { title?: string }; body?: string } };
  const heading = entry.data.title ? `# ${entry.data.title}\n\n` : '';
  return new Response(heading + (entry.body ?? ''), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
