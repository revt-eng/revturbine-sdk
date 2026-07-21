// Resolve the `@revturbine/sdk` version the Sandpack sandboxes install from npm.
//
// The docs demos should run against the exact SDK the docs describe, so we start
// from the version the sibling web-sdk source declares. But we must never bake in
// a version the sandboxes cannot install: the docs build runs right after the
// release pipeline, and a failed npm publish (with the version bump merged anyway)
// would pin a version that 404s — 500-ing the CodeSandbox packager and blanking
// EVERY Sandpack embed across the docs site, not just one page. That is exactly
// what happened when npm stalled at 0.2.24 while the docs requested an unpublished
// 0.2.26.
//
// So: use the declared version only when it is actually published; otherwise fall
// back to npm's latest published version. A registry lookup failure is non-fatal —
// degrade to the declared version rather than break the docs build (if npm is
// unreachable at build time the sandboxes can't install anything regardless).

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PACKAGE = '@revturbine/sdk';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE.replace('/', '%2F')}`;

/** The version the sibling web-sdk source declares (the version the docs describe). */
async function readDeclaredVersion() {
  const pkgPath = resolve(import.meta.dirname, '../../web-sdk/package.json');
  return JSON.parse(await readFile(pkgPath, 'utf8')).version;
}

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.warn]
 * @returns {Promise<string>} a version guaranteed (best-effort) to exist on npm
 */
export async function resolveSdkVersion({
  fetchImpl = fetch,
  timeoutMs = 10_000,
  warn = console.warn,
} = {}) {
  const declared = await readDeclaredVersion();

  try {
    const res = await fetchImpl(REGISTRY_URL, {
      // Abbreviated packument — smaller/faster, still carries `dist-tags` + the
      // full `versions` key set we need to test publication.
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const meta = await res.json();

    const isPublished = Boolean(meta.versions?.[declared]);
    const latest = meta['dist-tags']?.latest;

    if (isPublished) return declared; // happy path: release shipped, demo it exactly
    if (latest) {
      warn(
        `[sdk-version] web-sdk declares ${declared}, which is NOT published on npm; ` +
          `Sandpack demos will use the latest published version ${latest} instead. ` +
          `This usually means the npm release for ${declared} failed — check the ` +
          `"Publish to npm" workflow on revt-eng/revturbine-sdk.`,
      );
      return latest;
    }
    warn(
      `[sdk-version] no published ${PACKAGE} version found on npm; using declared ${declared}.`,
    );
    return declared;
  } catch (err) {
    warn(
      `[sdk-version] npm registry lookup failed (${err?.message ?? err}); ` +
        `using declared ${declared} for Sandpack demos.`,
    );
    return declared;
  }
}
