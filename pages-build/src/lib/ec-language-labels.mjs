/**
 * Expressive Code plugin: label every untitled code block with what it is.
 *
 * Readers kept asking "is this React or plain TypeScript?" — a `tsx` block
 * and a `ts` block look identical without a header. This gives each block a
 * frame title derived from its language unless the author set `title="…"`
 * (or `frame="none"`), so file-named blocks keep their file name.
 */
const LABELS = {
  tsx: 'React',
  jsx: 'React',
  ts: 'TypeScript',
  js: 'JavaScript',
  python: 'Python',
  py: 'Python',
  rust: 'Rust',
  rs: 'Rust',
  json: 'JSON',
  toml: 'TOML',
};

export function languageLabels() {
  return {
    name: 'language-labels',
    hooks: {
      // Runs after the built-in frames plugin's own preprocessCode, which is
      // where it lifts a leading `// path/file.tsx` comment into the title.
      preprocessCode: ({ codeBlock }) => {
        const props = codeBlock.props;
        if (props.title || props.frame === 'none' || props.frame === 'terminal') return;
        const label = LABELS[codeBlock.language];
        if (label) props.title = label;
      },
    },
  };
}
