import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
} from '@codesandbox/sandpack-react';
import React from 'react';

// Standard fixtures, mounted (hidden) into every example's virtual filesystem so
// the usage code can `import exportedConfig from './exported_config.json'` and
// `import { demoUsers } from './demoUsers'` — the same demo config + users the
// rest of the docs use. Raw-imported as strings via Vite's `?raw`.
// @ts-expect-error -- Vite raw import
import exportedConfigRaw from '../sandpack/example-exported_config.json?raw';
// @ts-expect-error -- Vite raw import
import demoUsersRaw from '../sandpack/demoUsers.ts?raw';
// @ts-expect-error -- Vite raw import
import sharedRaw from '../sandpack/shared.ts?raw';

// Published `@revturbine/sdk` version to install in the sandbox. Injected at build
// time from ../web-sdk/package.json via astro.config.mjs, so examples always run
// against the SDK the docs describe.
const SDK_VERSION = (import.meta.env.PUBLIC_SDK_VERSION as string) ?? '0.2.21';

const css = `
.rt-code-example { margin: 1.25rem 0; }
.rt-code-example .sp-wrapper { border-radius: 10px; overflow: hidden; }
.rt-code-example .sp-layout { border-radius: 10px; }
/* Stack editor above preview on narrow screens */
@media (max-width: 640px) {
  .rt-code-example .sp-layout { flex-direction: column; }
}
`;

export interface CodeExampleProps {
  /**
   * The example's `App.tsx` source — a runnable module that default-exports a
   * React component. Shown in the editor, rendered in the preview, and editable
   * live. It can import `@revturbine/sdk`, `./exported_config.json`, and
   * `./demoUsers` (all pre-mounted).
   */
  code: string;
  /** Extra npm dependencies to install (name → version range). `@revturbine/sdk` + react are always included. */
  dependencies?: Record<string, string>;
  /** Extra virtual files (path → contents) mounted alongside the standard fixtures. */
  files?: Record<string, string>;
  /** Editor/preview height in px. Default 360. */
  height?: number;
  /** Show the live preview panel. Default true. */
  showPreview?: boolean;
  /** Show the editable code panel. Default true. */
  showEditor?: boolean;
}

/**
 * Standardized docs example: the rendered view, the usage code, and a live
 * editor — in one Sandpack sandbox, pre-wired with the published
 * `@revturbine/sdk` and the shared demo config + users.
 *
 * Use it anywhere in the docs (component gallery, guides, tutorials) instead of
 * a static code block, so every example is runnable and editable. Embed with
 * `client:only="react"`:
 *
 * ```mdx
 * import CodeExample from '../../../components/CodeExample';
 *
 * export const code = `import { RevTurbineProvider, Slot } from "@revturbine/sdk";
 * import exportedConfig from "./exported_config.json";
 * import { demoUsers } from "./demoUsers";
 *
 * export default function App() {
 *   return (
 *     <RevTurbineProvider options={{ localRuntime: { exportedConfig }, user: demoUsers.user_carol.context }}>
 *       <Slot id="nav_bar_right" surfaceTemplateIds={["button"]} />
 *     </RevTurbineProvider>
 *   );
 * }
 * `;
 *
 * <CodeExample client:only="react" code={code} />
 * ```
 */
export default function CodeExample({
  code,
  dependencies,
  files,
  height = 360,
  showPreview = true,
  showEditor = true,
}: CodeExampleProps) {
  const sandpackFiles: Record<string, { code: string; hidden?: boolean; active?: boolean }> = {
    '/App.tsx': { code, active: true },
    // Hidden fixtures — importable, but not shown as editor tabs.
    '/exported_config.json': { code: exportedConfigRaw as string, hidden: true },
    '/demoUsers.ts': { code: demoUsersRaw as string, hidden: true },
    '/shared.ts': { code: sharedRaw as string, hidden: true },
    ...(files
      ? Object.fromEntries(Object.entries(files).map(([path, contents]) => [path, { code: contents }]))
      : {}),
  };

  return (
    <div className="rt-code-example">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <SandpackProvider
        template="react-ts"
        theme="auto"
        files={sandpackFiles}
        customSetup={{
          dependencies: {
            '@revturbine/sdk': SDK_VERSION,
            react: '^18',
            'react-dom': '^18',
            ...dependencies,
          },
        }}
        options={{ recompileMode: 'delayed', recompileDelay: 300 }}
      >
        <SandpackLayout>
          {showEditor && (
            <SandpackCodeEditor showLineNumbers showTabs={false} style={{ height }} />
          )}
          {showPreview && (
            <SandpackPreview showOpenInCodeSandbox={false} style={{ height }} />
          )}
        </SandpackLayout>
      </SandpackProvider>
    </div>
  );
}
