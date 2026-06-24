import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJourneySet } from './journey-writer';

/**
 * Plan 83 TASK-6: the dev-write middleware's persistence + safety. Tested here
 * because the middleware itself only runs inside the Vite dev server.
 */
describe('writeJourneySet', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prism-journeys-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const set = {
    id: 'my-set',
    label: 'My set',
    journeys: [{ id: 'j1', label: 'One', shows: 'x', state: { planHandle: 'free' } }],
  };

  it('writes a valid set to <id>.json', async () => {
    const result = await writeJourneySet(dir, set);
    expect(result.ok).toBe(true);
    const onDisk = JSON.parse(await readFile(join(dir, 'my-set.json'), 'utf8'));
    expect(onDisk.id).toBe('my-set');
    expect(onDisk.journeys[0].id).toBe('j1');
  });

  it('rejects an invalid set without writing', async () => {
    const result = await writeJourneySet(dir, { id: 'ok', label: 'ok' });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('rejects a traversal set id without writing', async () => {
    const result = await writeJourneySet(dir, { ...set, id: '../escape' });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await readdir(dir)).toHaveLength(0);
  });
});
