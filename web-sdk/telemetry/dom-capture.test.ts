/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-15 — annotated DOM capture privacy invariants (REQ-14, AC-15,
 * AC-16). These are the privacy guardrails, so they are exhaustive: the emitted
 * payload carries ONLY allowlisted `data-rt-prop-*` / `data-rt-ref` values —
 * never text, input values, hrefs, or selectors — a `data-rt-no-capture`
 * ancestor opts out a whole subtree, and sensitive controls are never captured.
 *
 * (The AC-15/16 observable in the plan is a Playwright spec; web-sdk has no
 * Playwright harness, so the same guarantees are asserted here against jsdom.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAnnotatedCapture } from './dom-capture';

let cleanup: (() => void) | null = null;
let emitted: Array<{ event: string; props: Record<string, string> }>;

beforeEach(() => {
  emitted = [];
  document.body.innerHTML = '';
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function install(opts = {}): void {
  cleanup?.();
  cleanup = installAnnotatedCapture(document, (event, props) => emitted.push({ event, props }), opts);
}
function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
const byId = (id: string): Element => document.getElementById(id)!;

describe('annotated DOM capture', () => {
  it('captures the declared event with ONLY allowlisted props — no text/href/title (AC-15)', () => {
    document.body.innerHTML =
      '<a id="b" data-rt-event="cta_clicked" data-rt-ref="hero" data-rt-prop-plan="pro" ' +
      'title="secret tooltip" href="/secret/path" name="field">Buy now for jane@acme.com</a>';
    install();
    click(byId('b'));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('cta_clicked');
    expect(emitted[0].props).toEqual({ plan: 'pro', ref: 'hero' });

    const serialized = JSON.stringify(emitted[0]);
    for (const forbidden of ['Buy now', 'jane@acme.com', '/secret/path', 'secret tooltip', 'field']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('resolves the nearest annotated ancestor from the click target', () => {
    document.body.innerHTML =
      '<div data-rt-event="card_clicked" data-rt-prop-id="c1"><span id="s">label</span></div>';
    install();
    click(byId('s'));
    expect(emitted[0].event).toBe('card_clicked');
    expect(emitted[0].props).toEqual({ id: 'c1' });
  });

  it('a data-rt-no-capture ancestor suppresses the element and its subtree (AC-15)', () => {
    document.body.innerHTML =
      '<section data-rt-no-capture><button id="b" data-rt-event="x" data-rt-prop-a="1"></button></section>';
    install();
    click(byId('b'));
    expect(emitted).toHaveLength(0);
  });

  it('never captures a password / file / hidden / payment-autocomplete input (AC-16)', () => {
    const cases: Array<{ type: string; autocomplete?: string }> = [
      { type: 'password' },
      { type: 'file' },
      { type: 'hidden' },
      { type: 'text', autocomplete: 'cc-number' },
      { type: 'text', autocomplete: 'current-password' },
    ];
    for (const { type, autocomplete } of cases) {
      emitted = [];
      document.body.innerHTML =
        `<input id="i" data-rt-event="typed" data-rt-prop-a="1" type="${type}"` +
        (autocomplete ? ` autocomplete="${autocomplete}">` : '>');
      install();
      click(byId('i'));
      expect(emitted, `type=${type} autocomplete=${autocomplete ?? ''}`).toHaveLength(0);
    }
  });

  it('caps prop count and per-value length', () => {
    document.body.innerHTML =
      `<button id="b" data-rt-event="x" data-rt-prop-a="${'x'.repeat(500)}" ` +
      'data-rt-prop-b="1" data-rt-prop-c="1"></button>';
    install({ maxProps: 2, maxValueLen: 10 });
    click(byId('b'));
    const props = emitted[0].props;
    expect(Object.keys(props).filter((k) => k !== 'ref')).toHaveLength(2); // count capped
    expect(props.a).toHaveLength(10); // value capped
  });

  it('does nothing for an element without data-rt-event', () => {
    document.body.innerHTML = '<button id="b" data-rt-prop-a="1">no event</button>';
    install();
    click(byId('b'));
    expect(emitted).toHaveLength(0);
  });

  it('cleanup removes every listener', () => {
    document.body.innerHTML = '<button id="b" data-rt-event="x"></button>';
    install();
    cleanup!();
    cleanup = null;
    click(byId('b'));
    expect(emitted).toHaveLength(0);
  });
});
