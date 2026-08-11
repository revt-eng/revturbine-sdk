import { describe, it, expect } from 'vitest';
import {
  ServerUserContextProvider,
  SERVER_TRAITS_DOMAIN,
} from './server-user-context-provider';

describe('ServerUserContextProvider (plan 165 TASK-4 / AC-4)', () => {
  it('is registered under the traits:server namespace', () => {
    expect(SERVER_TRAITS_DOMAIN).toBe('traits:server');
    expect(new ServerUserContextProvider().domain).toBe('traits:server');
  });

  it('contributes server trial + billing signals as traits', () => {
    const p = new ServerUserContextProvider();
    p.setSnapshot({
      trial: { in_trial: true, state: 'active', days_remaining: 5 },
      payment_at_risk: true,
    });
    expect(p.resolve()).toEqual({
      traits: {
        trial_active: true,
        trial_state: 'active',
        trial_days_remaining: 5,
        payment_at_risk: true,
      },
    });
    expect(p.hasSignals()).toBe(true);
  });

  it('emits no traits when the snapshot carries no signal', () => {
    const p = new ServerUserContextProvider();
    expect(p.resolve()).toEqual({ traits: {} });
    expect(p.hasSignals()).toBe(false);
  });

  it('surfaces only present signals (payment_at_risk:false is not asserted)', () => {
    const p = new ServerUserContextProvider();
    p.setSnapshot({ trial: { in_trial: false }, payment_at_risk: false });
    expect(p.resolve()).toEqual({ traits: { trial_active: false } });
  });

  it('replacing the snapshot replaces the surfaced traits', () => {
    const p = new ServerUserContextProvider();
    p.setSnapshot({ trial: { state: 'active' } });
    expect(p.resolve().traits).toEqual({ trial_state: 'active' });
    p.setSnapshot({ payment_at_risk: true });
    expect(p.resolve().traits).toEqual({ payment_at_risk: true });
  });
});
