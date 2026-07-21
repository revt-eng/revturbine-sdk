/**
 * Plan 118 TASK-20 — branding resolution ladder (AC-10).
 *
 * Verifies the four rungs and their priority: explicit → legacy config-embedded
 * (dev-warns) → branding API → DEFAULT_BRANDING, plus structural merge behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BRANDING,
  resolveBranding,
  __resetBrandingWarningForTests,
} from './branding';

const EXPLICIT = { workspace_name: 'Acme', logo_url: 'https://acme.test/logo.svg', theme: { primary: '#111' } };
const API = { workspace_name: 'Acme (API)', support_email: 'help@acme.test' };
const LEGACY_THEME = { primary: '#abc', radius: '8px' };

beforeEach(() => {
  __resetBrandingWarningForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveBranding — four-rung ladder', () => {
  it('rung 4: no inputs → DEFAULT_BRANDING (structural, renders fully)', () => {
    const { branding, source } = resolveBranding();
    expect(source).toBe('default');
    expect(branding.workspace_name).toBe(DEFAULT_BRANDING.workspace_name);
    expect(branding.theme).toEqual({});
  });

  it('rung 1: explicit branding wins over every lower rung', () => {
    const { branding, source } = resolveBranding({
      explicit: EXPLICIT,
      legacyConfigTheme: LEGACY_THEME,
      apiBranding: API,
    });
    expect(source).toBe('explicit');
    expect(branding.workspace_name).toBe('Acme');
    expect(branding.logo_url).toBe('https://acme.test/logo.svg');
    // Theme merges over the default map.
    expect(branding.theme).toEqual({ primary: '#111' });
  });

  it('rung 2: legacy config theme is used when no explicit branding, and dev-warns', () => {
    const { branding, source } = resolveBranding({
      legacyConfigTheme: LEGACY_THEME,
      apiBranding: API,
    });
    expect(source).toBe('legacy-config');
    expect(branding.theme).toEqual(LEGACY_THEME);
    // API is a lower rung — not applied when legacy theme is present.
    expect(branding.support_email).toBeUndefined();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('deprecated');
  });

  it('rung 2: the deprecation warning fires at most once', () => {
    resolveBranding({ legacyConfigTheme: LEGACY_THEME });
    resolveBranding({ legacyConfigTheme: LEGACY_THEME });
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('rung 2: warnOnLegacy:false silences the warning but still resolves', () => {
    const { source } = resolveBranding({ legacyConfigTheme: LEGACY_THEME, warnOnLegacy: false });
    expect(source).toBe('legacy-config');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('rung 3: branding API used when no explicit and no legacy theme', () => {
    const { branding, source } = resolveBranding({ apiBranding: API });
    expect(source).toBe('branding-api');
    expect(branding.workspace_name).toBe('Acme (API)');
    expect(branding.support_email).toBe('help@acme.test');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('merge: every rung fills gaps from DEFAULT_BRANDING so the result is complete', () => {
    // API supplies workspace_name + support_email but no theme; theme falls to default.
    const { branding } = resolveBranding({ apiBranding: { support_email: 'x@y.z' } });
    expect(branding.workspace_name).toBe(DEFAULT_BRANDING.workspace_name);
    expect(branding.theme).toEqual({});
    expect(branding.support_email).toBe('x@y.z');
  });

  it('empty objects are treated as absent (fall through to the next rung)', () => {
    const { source } = resolveBranding({ explicit: {}, legacyConfigTheme: {}, apiBranding: API });
    expect(source).toBe('branding-api');
  });
});
