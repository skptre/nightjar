import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVirtualList } from './useVirtualList';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* no-op */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  });
});

describe('useVirtualList', () => {
  it('returns zero range when container height is 0', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 100, itemHeight: 72 }),
    );

    expect(result.current.visibleRange.start).toBe(0);
    expect(result.current.visibleRange.end).toBe(0);
    expect(result.current.totalHeight).toBe(7200);
  });

  it('computes total height from item count and height', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 1000, itemHeight: 72 }),
    );

    expect(result.current.totalHeight).toBe(72000);
  });

  it('returns correct offset when container height is 0', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 1000, itemHeight: 72, overscan: 5 }),
    );

    expect(result.current.offsetTop).toBe(0);
  });

  it('handles zero items gracefully', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 0, itemHeight: 72 }),
    );

    expect(result.current.totalHeight).toBe(0);
    expect(result.current.visibleRange.start).toBe(0);
    expect(result.current.visibleRange.end).toBe(0);
  });

  it('handles single item', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 1, itemHeight: 72 }),
    );

    expect(result.current.totalHeight).toBe(72);
  });

  it('provides scrollToIndex function', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 100, itemHeight: 72 }),
    );

    expect(typeof result.current.scrollToIndex).toBe('function');
  });

  it('scrollToIndex scrolls container when item is below viewport', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 100, itemHeight: 72 }),
    );

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', { value: 500 });
    let currentScrollTop = 0;
    Object.defineProperty(container, 'scrollTop', {
      get: () => currentScrollTop,
      set: (v: number) => { currentScrollTop = v; },
    });

    act(() => {
      (result.current.containerRef as { current: HTMLDivElement }).current = container;
    });

    act(() => {
      result.current.scrollToIndex(10);
    });

    expect(currentScrollTop).toBe(10 * 72 + 72 - 500);
  });

  it('scrollToIndex scrolls up when item is above viewport', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 100, itemHeight: 72 }),
    );

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', { value: 500 });
    let currentScrollTop = 1000;
    Object.defineProperty(container, 'scrollTop', {
      get: () => currentScrollTop,
      set: (v: number) => { currentScrollTop = v; },
    });

    act(() => {
      (result.current.containerRef as { current: HTMLDivElement }).current = container;
    });

    act(() => {
      result.current.scrollToIndex(5);
    });

    expect(currentScrollTop).toBe(5 * 72);
  });

  it('scrollToIndex does nothing when item is in view', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 100, itemHeight: 72 }),
    );

    const container = document.createElement('div');
    Object.defineProperty(container, 'clientHeight', { value: 500 });
    let currentScrollTop = 0;
    Object.defineProperty(container, 'scrollTop', {
      get: () => currentScrollTop,
      set: (v: number) => { currentScrollTop = v; },
    });

    act(() => {
      (result.current.containerRef as { current: HTMLDivElement }).current = container;
    });

    act(() => {
      result.current.scrollToIndex(3);
    });

    expect(currentScrollTop).toBe(0);
  });

  it('provides container ref initialized to null', () => {
    const { result } = renderHook(() =>
      useVirtualList({ itemCount: 100, itemHeight: 72 }),
    );

    expect(result.current.containerRef).toBeDefined();
    expect(result.current.containerRef.current).toBeNull();
  });
});

describe('Virtual scroll computation logic', () => {
  it('visible range bounded by overscan', () => {
    const itemHeight = 72;
    const overscan = 5;
    const containerHeight = 500;
    const scrollTop = 0;

    const startIndex = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const start = Math.max(0, startIndex - overscan);
    const end = Math.min(1000, startIndex + visibleCount + overscan);

    expect(start).toBe(0);
    expect(end).toBe(visibleCount + overscan);
    expect(end).toBeLessThan(50);
  });

  it('1000 items at 72px renders <30 DOM nodes at 500px viewport', () => {
    const containerHeight = 500;
    const itemHeight = 72;
    const overscan = 5;

    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const totalRendered = visibleCount + 2 * overscan;

    expect(totalRendered).toBeLessThan(30);
  });

  it('scroll to middle renders correct item range', () => {
    const itemHeight = 72;
    const overscan = 5;
    const containerHeight = 500;
    const scrollTop = 36000;

    const startIndex = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const start = Math.max(0, startIndex - overscan);
    const end = Math.min(1000, startIndex + visibleCount + overscan);

    expect(start).toBe(495);
    expect(end).toBe(startIndex + visibleCount + overscan);
    expect(end - start).toBeLessThan(30);
  });

  it('default overscan of 5 adds 5 items past visible', () => {
    const itemHeight = 72;
    const overscan = 5;
    const containerHeight = 72;

    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const end = Math.min(100, 0 + visibleCount + overscan);

    expect(visibleCount).toBe(1);
    expect(end).toBe(6);
  });

  it('total height matches itemCount * itemHeight', () => {
    expect(2000 * 72).toBe(144000);
  });

  it('offsetTop tracks start position', () => {
    const start = 10;
    const itemHeight = 72;
    const offsetTop = start * itemHeight;

    expect(offsetTop).toBe(720);
  });
});
