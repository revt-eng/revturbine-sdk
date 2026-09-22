import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import baseline from '../tests/reason-contract.json';
import { assertReasonContract, projectReasonCodes } from '../scripts/reason-contract.mjs';
import { reasonObservations, type ReasonObservation } from '../tests/reason-contract/cases';
import { RevTurbineCustomerSdk } from './headless';

let observations: ReasonObservation[];
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) =>
    new Response('{}', { status: String(url).includes('/sdk/config') ? 503 : 200 })));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  observations = await reasonObservations();
});
afterAll(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('public built-in reason values (plan 254 AC-7)', () => {
  it('emits every protected value through live fixtures at the installed core pin', () => {
    assertReasonContract(baseline, observations);
  });

  const protectedCodes = Object.entries({ entitlement: baseline.entitlement, placement: baseline.placement })
    .flatMap(([surface, codes]) => codes.map(code => ({ surface, code })));
  it.each(protectedCodes)('rejects removal and rename of $surface/$code', ({ surface, code }) => {
    // Controlled mutations of LIVE results, using the same verifier as the
    // positive check. A stale string in a comment/source cannot keep this green.
    assertReasonContract(baseline, observations);
    const actual = projectReasonCodes(observations);
    const projected = Object.entries(actual).flatMap(([lane, codes]) => codes.map(value => ({
      surface: lane, fixture: `mutation/${value}`,
      result: lane === 'entitlement' ? { reason: value } : { reasonCodes: [value] },
    })));
    const removed = projected.filter(row => !(row.surface === surface && row.fixture === `mutation/${code}`));
    expect(() => assertReasonContract(baseline, removed), `removed ${surface}/${code}`).toThrow();
    const renamed = [...removed, { surface, fixture: 'renamed', result: surface === 'entitlement'
      ? { reason: `${code}_renamed` } : { reasonCodes: [`${code}_renamed`] } }];
    expect(() => assertReasonContract(baseline, renamed), `renamed ${surface}/${code}`).toThrow();
  });

  it('ignores free-form message, content and diagnostic reason edits', () => {
    const changed = observations.map(row => ({ ...row, result: Array.isArray(row.result) ? row.result : {
      ...(row.result && typeof row.result === 'object' ? row.result : {}), message: 'new diagnostic wording',
      content: { body: 'new copy', reason: 'not_a_decision_reason' },
      diagnostic: { reason: 'free_form_reason' },
    } }));
    assertReasonContract(baseline, changed);
  });

  it('keeps custom resolver reason strings extensible', async () => {
    const sdk = new RevTurbineCustomerSdk({ tenantId: 'custom_reason', apiKey: 'local',
      endpoint: 'https://reason.example.test', mode: 'snippet', runtimeMode: 'local_only', previewMode: true,
      localRuntime: { resolvers: { checkEntitlement: async () => ({
        status: 'denied', allowed: false, reason: 'customer_owned_contract',
      }) } },
    });
    try { expect((await sdk.checkEntitlement('feature')).reason).toBe('customer_owned_contract'); }
    finally { sdk.dispose(); }
  });
});
