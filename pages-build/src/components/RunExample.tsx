import React, { Suspense, useState } from 'react';
import type { CodeExampleProps } from './CodeExample';

// Sandpack (its editor, its iframe, its remote bundler) loads only when a reader
// asks for it. The code itself is already on the page, rendered at build time by
// LiveExample.astro, so nothing is invisible while JavaScript arrives.
const CodeExample = React.lazy(() => import('./CodeExample'));

const css = `
.rt-run-example { margin: -0.5rem 0 1.25rem; display: flex; align-items: center; gap: 0.75rem; }
.rt-run-example button {
  font: inherit; font-size: 0.9rem; padding: 0.4rem 0.9rem; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--sl-color-gray-4); background: var(--sl-color-gray-6); color: var(--sl-color-white);
}
.rt-run-example button:hover { background: var(--sl-color-gray-5); }
.rt-run-example span { font-size: 0.85rem; color: var(--sl-color-gray-2); }
`;

/** A "Run this example" button that mounts the live Sandpack editor on demand. */
export default function RunExample(props: CodeExampleProps) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <p className="rt-run-example not-content">
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <button type="button" onClick={() => setOpen(true)}>
          Run this example
        </button>
        <span>Opens a live, editable sandbox with the published SDK.</span>
      </p>
    );
  }
  return (
    <Suspense fallback={<p className="rt-run-example not-content"><span>Loading the sandbox…</span></p>}>
      <CodeExample {...props} />
    </Suspense>
  );
}
