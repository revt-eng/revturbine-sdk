/**
 * Plan 144 TASK-7 — bounded, byte-identical, best-effort delivery (REQ-4,
 * AC-23, AC-17). The retry must resend the SAME bytes so storage-layer dedup
 * collapses a re-delivery to one row; it must never throw so a failed send
 * can't crash the app or block a mirror.
 */
import { describe, expect, it, vi } from 'vitest';
import { deliverWithRetry } from './delivery';

const noSleep = () => Promise.resolve();

function res(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

describe('deliverWithRetry', () => {
  it('sends once and stops when the first attempt succeeds', async () => {
    const attempt = vi.fn(() => Promise.resolve(res(202)));
    const outcome = await deliverWithRetry(attempt, { sleep: noSleep });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ delivered: true, status: 202, attempts: 1 });
  });

  it('retries a thrown transport error, then succeeds', async () => {
    const attempt = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(res(202));
    const outcome = await deliverWithRetry(attempt, { sleep: noSleep });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ delivered: true, attempts: 2 });
  });

  it('retries a transient 503, then succeeds', async () => {
    const attempt = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(202));
    const outcome = await deliverWithRetry(attempt, { sleep: noSleep });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(outcome.delivered).toBe(true);
  });

  it('does NOT retry a permanent 400 — resending identical bytes cannot fix it', async () => {
    const attempt = vi.fn(() => Promise.resolve(res(400)));
    const outcome = await deliverWithRetry(attempt, { sleep: noSleep });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ delivered: false, status: 400, attempts: 1 });
  });

  it('retries 408 and 429 (transient throttling), unlike other 4xx', async () => {
    for (const status of [408, 429]) {
      const attempt = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(res(status))
        .mockResolvedValueOnce(res(202));
      const outcome = await deliverWithRetry(attempt, { sleep: noSleep });
      expect(attempt, `status ${status} should retry`).toHaveBeenCalledTimes(2);
      expect(outcome.delivered).toBe(true);
    }
  });

  it('exhausts the bound and resolves (never rejects) on persistent failure', async () => {
    const attempt = vi.fn(() => Promise.reject(new Error('down')));
    const outcome = await deliverWithRetry(attempt, { retries: 2, sleep: noSleep });
    expect(attempt).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(outcome.delivered).toBe(false);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.attempts).toBe(3);
  });

  it('resends the byte-identical request on every attempt', async () => {
    // A caller thunk that closes over ONE pre-built body — the whole point of
    // the API. Each attempt re-sends the same reference, so the row's
    // request_id is preserved across the retry.
    const bodies: string[] = [];
    const init = { body: JSON.stringify({ events: [{ request_id: 'rid-fixed' }] }) };
    let calls = 0;
    const attempt = () => {
      bodies.push(init.body);
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve(res(202));
    };
    const outcome = await deliverWithRetry(attempt, { sleep: noSleep });
    expect(outcome.delivered).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]); // identical bytes
    expect(JSON.parse(bodies[1]).events[0].request_id).toBe('rid-fixed');
  });

  it('backs off between attempts using the injected sleep', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const attempt = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValueOnce(res(202));
    await deliverWithRetry(attempt, { baseDelayMs: 100, sleep });
    // Waited before attempt 2 (100ms) and attempt 3 (200ms); no wait after success.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });
});
