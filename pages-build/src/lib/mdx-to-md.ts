/**
 * MDX source → plain Markdown, for the files written FOR agents: every page's
 * `.md` twin (`src/pages/[...slug].md.ts`) and the `llms*.txt` artifacts.
 *
 * Those files carried raw MDX — 98 `import` lines, `export const code = \`…\``
 * blocks, `<Aside>` / `<Tabs>` / `<LiveExample>` JSX — because rendering the
 * pages through the llms plugin's container fails on `client:only` islands.
 * Rendering isn't needed: the MDX-isms are a small, known set, so this strips
 * them and turns the live examples back into fenced code.
 *
 * Fenced code blocks are left untouched — `<Slot>` / `<Gate>` inside them are
 * the product, not MDX.
 */

const DOC_COMPONENTS = ['Tabs', 'TabItem', 'Steps', 'Card', 'CardGrid', 'LinkCard', 'Aside'];

export function mdxToMarkdown(source: string): string {
  // Snippets are resolved in document order: `export const code = …` on one
  // page must not feed `<LiveExample code={code}>` on the next when several
  // pages are concatenated (llms-full.txt).
  const snippets = new Map<string, string>();
  const tokenRe =
    /^export const (\w+) = `([\s\S]*?)`;[ \t]*$|<(?:LiveExample|CodeExample)\b[^>]*?code=\{(\w+)\}[^>]*?\/>/gm;
  let src = source.replace(tokenRe, (m, name?: string, body?: string, ref?: string) => {
    if (name !== undefined) {
      snippets.set(name, (body ?? '').replace(/\\`/g, '`').replace(/\\\$\{/g, '${'));
      return '';
    }
    const code = ref ? snippets.get(ref) : undefined;
    return code === undefined ? '' : '```tsx\n' + code.trimEnd() + '\n```';
  });

  // Everything else is prose-only: leave fenced code alone.
  const parts = src.split(/(```[\s\S]*?```)/g);
  src = parts.map((part, i) => (i % 2 === 1 ? part : cleanProse(part))).join('');
  return src.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function cleanProse(t: string): string {
  t = t.replace(/^import\s[^\n]*?;[ \t]*$/gm, '');
  t = t.replace(/^export const \w+ = [^\n]*$/gm, '');
  t = t.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  t = t.replace(
    /<(?:LivePlayground|SandpackPlayground)\b[^>]*?scenarioId="([^"]+)"[^>]*?\/>/g,
    (_m, id: string) => `_Live example: /playground/#${id}_`,
  );
  t = t.replace(/<Aside\b([^>]*)>/g, (_m, attrs: string) => {
    const title = /title="([^"]*)"/.exec(attrs)?.[1];
    const type = /type="([^"]*)"/.exec(attrs)?.[1] ?? 'note';
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    return `**${title ? `${label} — ${title}` : label}:**`;
  });
  t = t.replace(/<TabItem\b[^>]*?label="([^"]*)"[^>]*>/g, (_m, label: string) => `**${label}**\n`);
  t = t.replace(/<Card\b[^>]*?title="([^"]*)"[^>]*>/g, (_m, title: string) => `**${title}**\n`);
  t = t.replace(
    /<LinkCard\b[^>]*?title="([^"]*)"[^>]*?href="([^"]*)"[^>]*?\/>/g,
    (_m, title: string, href: string) => `- [${title}](${href})`,
  );
  const tagRe = new RegExp(`</?(?:${DOC_COMPONENTS.join('|')})\\b[^>]*>`, 'g');
  t = t.replace(tagRe, '');
  t = t.replace(/<a id="[^"]*"><\/a>/g, '');
  return t;
}
