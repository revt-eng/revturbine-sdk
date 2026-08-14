/**
 * Plan 182 TASK-5 — `sdk_error` finally has an emitter.
 *
 * It was declared in `SdkMetaEventTypeSchema` with no emit site anywhere, which
 * is exactly the declared-but-dead class plan 181's parity gate will catch
 * going forward. It is the "the SDK itself malfunctioned" signal, distinct from
 * `resolution_failure` ("a decision produced nothing"), and rides the anonymous
 * `events_sdk_meta` lane — no tenant, no user identity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initRevTurbine } from './customer-side';

type Diagnosable = {
  postAnonMeta: (t: string, e?: unknown) => Promise<void>;
  diagnosticTelemetryActive: () => boolean;
};

function makeSdk() {
  return initRevTurbine({
    tenantId: 'tenant_test',
    apiKey: 'rt_test_key',
    endpoint: 'https://edge.example.test',
    mode: 'headless',
  });
}

/**
 * The diagnostics gate requires a browser (`isBrowser()`); these run in node.
 * Stub the SHARED gate rather than the emitter, so what is under test stays
 * `reportSdkError`'s own payload + dedup behavior.
 */
function enableDiagnostics(sdk: ReturnType<typeof initRevTurbine>) {
  vi.spyOn(sdk as unknown as Diagnosable, 'diagnosticTelemetryActive').mockReturnValue(true);
  return vi
    .spyOn(sdk as unknown as Diagnosable, 'postAnonMeta')
    .mockResolvedValue(undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reportSdkError', () => {
  it('posts an sdk_error on the anonymous meta lane', async () => {
    const sdk = makeSdk();
    const post = enableDiagnostics(sdk);

    sdk.reportSdkError('provider_init_failed', 'boom');

    expect(post).toHaveBeenCalledWith('sdk_error', { reason: 'provider_init_failed', message: 'boom' });
  });

  it('omits message when none is supplied rather than sending an empty string', () => {
    const sdk = makeSdk();
    const post = enableDiagnostics(sdk);

    sdk.reportSdkError('provider_init_failed');

    expect(post).toHaveBeenCalledWith('sdk_error', { reason: 'provider_init_failed' });
  });

  it('dedupes on reason — a failure inside a render loop must not flood', () => {
    const sdk = makeSdk();
    const post = enableDiagnostics(sdk);

    sdk.reportSdkError('provider_init_failed', 'first');
    sdk.reportSdkError('provider_init_failed', 'second');
    sdk.reportSdkError('provider_init_failed', 'third');

    expect(post).toHaveBeenCalledTimes(1);
  });

  it('still reports a genuinely different reason', () => {
    const sdk = makeSdk();
    const post = enableDiagnostics(sdk);

    sdk.reportSdkError('provider_init_failed', 'a');
    sdk.reportSdkError('bootstrap_failed', 'b');

    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never throws — it is called from catch blocks', () => {
    const sdk = makeSdk();
    vi.spyOn(sdk as unknown as Diagnosable, 'diagnosticTelemetryActive').mockReturnValue(true);
    vi.spyOn(sdk as unknown as Diagnosable, 'postAnonMeta').mockImplementation(() => {
      throw new Error('transport exploded');
    });

    expect(() => sdk.reportSdkError('provider_init_failed', 'x')).not.toThrow();
  });

  it('stays silent when diagnostics are inactive (no browser / analytics off)', () => {
    const sdk = makeSdk();
    const post = vi
      .spyOn(sdk as unknown as Diagnosable, 'postAnonMeta')
      .mockResolvedValue(undefined);

    // Gate NOT stubbed — node has no browser, so the shared guard blocks.
    sdk.reportSdkError('provider_init_failed', 'x');

    expect(post).not.toHaveBeenCalled();
  });
});
