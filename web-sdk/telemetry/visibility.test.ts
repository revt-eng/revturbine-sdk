/**
 * Plan 144 TASK-9 — viewport-exposure substrate (REQ-18, AC-10).
 *
 * Pins the two design points: one shared `IntersectionObserver` per distinct
 * config, and graceful `render_fallback` when `IntersectionObserver` is absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExposureManager } from './visibility';

type IOEntry = { target: Element; isIntersecting: boolean; intersectionRatio: number };

/** Controllable IntersectionObserver stub that lets a test drive intersections. */
class MockIO {
  static instances: MockIO[] = [];
  readonly observed = new Set<Element>();
  private readonly cb: (entries: IOEntry[], io: MockIO) => void;
  readonly options: unknown;
  constructor(cb: (entries: IOEntry[], io: MockIO) => void, options: unknown) {
    this.cb = cb;
    this.options = options;
    MockIO.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.add(el);
  }
  unobserve(el: Element): void {
    this.observed.delete(el);
  }
  disconnect(): void {
    this.observed.clear();
  }
  emit(el: Element, isIntersecting: boolean, intersectionRatio = 1): void {
    this.cb([{ target: el, isIntersecting, intersectionRatio }], this);
  }
}

const el = (id: string) => ({ id }) as unknown as Element;
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('exposure manager — IntersectionObserver available', () => {
  beforeEach(() => {
    MockIO.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIO);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports supported', () => {
    expect(createExposureManager().supported).toBe(true);
  });

  it('shares ONE observer across elements with the same config, a new one per distinct config', () => {
    const m = createExposureManager();
    m.observe(el('a'), { threshold: 0.5 }, () => {});
    m.observe(el('b'), { threshold: 0.5 }, () => {});
    expect(MockIO.instances).toHaveLength(1); // shared

    m.observe(el('c'), { threshold: 0.9 }, () => {});
    expect(MockIO.instances).toHaveLength(2); // distinct threshold → new observer
  });

  it('fires "viewport" exactly once when the element intersects', () => {
    const m = createExposureManager();
    const onExposed = vi.fn();
    const a = el('a');
    m.observe(a, { threshold: 0.5 }, onExposed);

    const io = MockIO.instances[0];
    io.emit(a, true);
    io.emit(a, true); // ignored — already settled
    expect(onExposed).toHaveBeenCalledTimes(1);
    expect(onExposed).toHaveBeenCalledWith('viewport');
    expect(io.observed.has(a)).toBe(false); // unobserved after firing
  });

  it('honors minVisibleMs dwell and cancels if the element leaves early', () => {
    vi.useFakeTimers();
    const m = createExposureManager();
    const onExposed = vi.fn();
    const a = el('a');
    m.observe(a, { threshold: 0.5, minVisibleMs: 100 }, onExposed);
    const io = MockIO.instances[0];

    io.emit(a, true);
    expect(onExposed).not.toHaveBeenCalled(); // dwell not yet elapsed
    vi.advanceTimersByTime(50);
    io.emit(a, false); // left before dwell completes → cancel
    vi.advanceTimersByTime(100);
    expect(onExposed).not.toHaveBeenCalled();

    io.emit(a, true); // re-enter, complete the dwell
    vi.advanceTimersByTime(100);
    expect(onExposed).toHaveBeenCalledTimes(1);
    expect(onExposed).toHaveBeenCalledWith('viewport');
  });

  it('stops observing after the returned cleanup runs', () => {
    const m = createExposureManager();
    const onExposed = vi.fn();
    const a = el('a');
    const stop = m.observe(a, { threshold: 0.5 }, onExposed);
    const io = MockIO.instances[0];

    stop();
    expect(io.observed.has(a)).toBe(false);
    io.emit(a, true);
    expect(onExposed).not.toHaveBeenCalled();
  });
});

describe('exposure manager — IntersectionObserver unavailable (AC-10)', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unsupported and falls back to render_fallback rather than failing', async () => {
    const m = createExposureManager();
    expect(m.supported).toBe(false);

    const onExposed = vi.fn();
    m.observe(el('a'), {}, onExposed);
    expect(onExposed).not.toHaveBeenCalled(); // scheduled async, not sync

    await flushMicrotasks();
    expect(onExposed).toHaveBeenCalledWith('render_fallback');
  });

  it('cleanup cancels the pending render_fallback', async () => {
    const m = createExposureManager();
    const onExposed = vi.fn();
    const stop = m.observe(el('a'), {}, onExposed);
    stop();
    await flushMicrotasks();
    expect(onExposed).not.toHaveBeenCalled();
  });
});
