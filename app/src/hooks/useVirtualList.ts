import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

export interface VirtualListConfig {
  itemCount: number;
  itemHeight: number;
  overscan?: number;
}

export interface VirtualListResult {
  visibleRange: { start: number; end: number };
  totalHeight: number;
  offsetTop: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  scrollToIndex: (index: number) => void;
}

export function useVirtualList({
  itemCount,
  itemHeight,
  overscan = 5,
}: VirtualListConfig): VirtualListResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const rafId = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });

    observer.observe(container);
    setContainerHeight(container.clientHeight);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = (): void => {
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(() => {
        setScrollTop(container.scrollTop);
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafId.current);
    };
  }, []);

  const totalHeight = itemCount * itemHeight;

  const { visibleRange, offsetTop } = useMemo(() => {
    if (containerHeight === 0 || itemCount === 0) {
      return { visibleRange: { start: 0, end: 0 }, offsetTop: 0 };
    }

    const startIndex = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);

    const start = Math.max(0, startIndex - overscan);
    const end = Math.min(itemCount, startIndex + visibleCount + overscan);

    return {
      visibleRange: { start, end },
      offsetTop: start * itemHeight,
    };
  }, [scrollTop, containerHeight, itemCount, itemHeight, overscan]);

  const scrollToIndex = useCallback(
    (index: number): void => {
      const container = containerRef.current;
      if (!container) return;

      const viewHeight = container.clientHeight;
      const itemTop = index * itemHeight;
      const itemBottom = itemTop + itemHeight;

      if (itemTop < container.scrollTop) {
        container.scrollTop = itemTop;
      } else if (itemBottom > container.scrollTop + viewHeight) {
        container.scrollTop = itemBottom - viewHeight;
      }
    },
    [itemHeight],
  );

  return {
    visibleRange,
    totalHeight,
    offsetTop,
    containerRef,
    scrollToIndex,
  };
}
