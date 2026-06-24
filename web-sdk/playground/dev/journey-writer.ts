import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parseJourneySet } from '../state/journey-schema';

export type WriteResult =
  | { ok: true; file: string }
  | { ok: false; status: number; error: string };

/**
 * Persist a posted journey set to `<journeysDir>/<set.id>.json` (plan 83
 * TASK-6). Used by the dev-only Vite middleware. The set id is validated to a
 * safe slug by {@link parseJourneySet}; the resolved-path check below is a
 * second, independent guard so a future loosening of that regex still can't
 * write outside `journeysDir`. Pure + node-only so it is unit-testable without
 * the dev server.
 */
export async function writeJourneySet(journeysDir: string, raw: unknown): Promise<WriteResult> {
  const set = parseJourneySet(raw);
  if (!set) return { ok: false, status: 400, error: 'Invalid journey set' };

  const root = resolve(journeysDir);
  const file = resolve(join(journeysDir, `${set.id}.json`));
  if (file !== join(root, `${set.id}.json`) || !file.startsWith(root + sep)) {
    return { ok: false, status: 400, error: 'Refusing to write outside journeys directory' };
  }

  await mkdir(root, { recursive: true });
  await writeFile(file, `${JSON.stringify(set, null, 2)}\n`, 'utf8');
  return { ok: true, file };
}
