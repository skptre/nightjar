// Shared motion helpers. Everything here writes styles straight to the DOM, so
// pointer-driven effects never cost a React render per frame.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export function prefersReducedMotion(): boolean {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Runs `fn` as soon as the next render is on screen: once in a microtask, then on
 * each frame for a short while. `fn` is expected to do its job once and no-op after.
 */
export function afterRender(fn: () => void, frames = 20): void {
  void Promise.resolve().then(fn);
  let n = 0;
  const tick = (): void => { fn(); if (++n < frames) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

/** Cursor light + edge highlight for a panel. Spread the handlers on the panel element. */
export function useCursorGlow(): {
  glowRef: React.RefObject<HTMLDivElement | null>;
  edgeRef: React.RefObject<HTMLDivElement | null>;
  onMouseMove: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
} {
  const glowRef = useRef<HTMLDivElement | null>(null);
  const edgeRef = useRef<HTMLDivElement | null>(null);
  const pos = useRef<{ x: number; y: number } | null>(null);
  const target = useRef({ x: 0, y: 0 });
  const raf = useRef<number | null>(null);
  const tick = useCallback((): void => {
    const p = pos.current, t = target.current, g = glowRef.current, ed = edgeRef.current;
    if (!p || !g) { raf.current = null; return; }
    p.x += (t.x - p.x) * 0.18;
    p.y += (t.y - p.y) * 0.18;
    g.style.transform = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
    if (ed) { ed.style.setProperty('--mx', `${p.x.toFixed(1)}px`); ed.style.setProperty('--my', `${p.y.toFixed(1)}px`); }
    raf.current = Math.abs(t.x - p.x) + Math.abs(t.y - p.y) > 0.4 ? requestAnimationFrame(tick) : null;
  }, []);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLElement>): void => {
    const el = e.currentTarget, r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    target.current = { x: (e.clientX - r.left) / r.width * el.offsetWidth, y: (e.clientY - r.top) / r.height * el.offsetHeight };
    if (!pos.current) {
      pos.current = { ...target.current };
      if (glowRef.current) glowRef.current.style.opacity = '1';
      if (edgeRef.current) edgeRef.current.style.opacity = '1';
    }
    if (!raf.current) raf.current = requestAnimationFrame(tick);
  }, [tick]);
  const onMouseLeave = useCallback((): void => {
    pos.current = null;
    if (glowRef.current) glowRef.current.style.opacity = '0';
    if (edgeRef.current) edgeRef.current.style.opacity = '0';
  }, []);
  return { glowRef, edgeRef, onMouseMove, onMouseLeave };
}

/**
 * One highlight that slides between rows instead of each row lighting up on its
 * own. Rows opt in with `data-glide`; rows marked `data-noglide` hide it.
 */
export function useGlide(): {
  glideRef: React.RefObject<HTMLDivElement | null>;
  onMouseMove: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  hide: () => void;
} {
  const glideRef = useRef<HTMLDivElement | null>(null);
  const last = useRef<{ row: HTMLElement | null; y: number; h: number }>({ row: null, y: 0, h: 0 });
  const glideTo = useCallback((row: HTMLElement | null): void => {
    const g = glideRef.current;
    if (!g) return;
    if (!row || row.hasAttribute('data-noglide')) { g.style.opacity = '0'; last.current.row = null; return; }
    const y = row.offsetTop, h = row.offsetHeight;
    const st = last.current;
    if (st.row === row && st.y === y && st.h === h) return;
    const shown = g.style.opacity === '1';
    g.style.transition = shown ? 'top 480ms var(--spring), height 480ms var(--spring), opacity 220ms ease' : 'opacity 220ms ease';
    g.style.top = `${String(y)}px`;
    g.style.height = `${String(h)}px`;
    g.style.opacity = '1';
    last.current = { row, y, h };
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent<HTMLElement>): void => {
    const target = e.target as HTMLElement | null;
    glideTo(target?.closest?.<HTMLElement>('[data-glide]') ?? null);
  }, [glideTo]);
  const hide = useCallback((): void => glideTo(null), [glideTo]);
  return { glideRef, onMouseMove, onMouseLeave: hide, hide };
}

/** Cards lean toward the pointer and catch a soft light where it sits. */
export const tilt = {
  onMouseMove(e: React.MouseEvent<HTMLElement>): void {
    if (prefersReducedMotion()) return;
    const c = e.currentTarget, r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    c.style.transition = 'transform 160ms ease-out, border-color 220ms ease';
    c.style.transform = `perspective(900px) rotateX(${((0.5 - py) * 7).toFixed(2)}deg) rotateY(${((px - 0.5) * 9).toFixed(2)}deg) translateZ(10px)`;
    c.style.setProperty('--sx', `${(px * 100).toFixed(1)}%`);
    c.style.setProperty('--sy', `${(py * 100).toFixed(1)}%`);
    c.style.setProperty('--so', '1');
  },
  onMouseLeave(e: React.MouseEvent<HTMLElement>): void {
    const c = e.currentTarget;
    c.style.transition = 'transform 900ms var(--bounce), border-color 220ms ease';
    c.style.transform = '';
    c.style.setProperty('--so', '0');
  },
};

/** Records row positions so rows that survive a change can slide to their new place. */
export function snapshotRows(container: HTMLElement | null, selector: string): Map<string, number> | null {
  if (!container) return null;
  const snap = new Map<string, number>();
  container.querySelectorAll<HTMLElement>(selector).forEach((row) => {
    if (row.dataset.id) snap.set(row.dataset.id, row.offsetTop);
  });
  return snap;
}

/** FLIP: rows present in the snapshot animate from their old position. Returns true once applied. */
export function playFlip(container: HTMLElement | null, selector: string, snap: Map<string, number> | null, duration = 640): boolean {
  if (!snap || !container) return true;
  const rows = Array.from(container.querySelectorAll<HTMLElement>(selector));
  const moved = rows.filter((r) => r.dataset.id && snap.has(r.dataset.id) && snap.get(r.dataset.id) !== r.offsetTop);
  const same = rows.length === snap.size && rows.every((r) => r.dataset.id && snap.has(r.dataset.id));
  if (same && !moved.length) return false;
  if (prefersReducedMotion()) return true;
  moved.forEach((r) => {
    r.style.transition = 'none';
    r.style.transform = `translateY(${String(snap.get(r.dataset.id!)! - r.offsetTop)}px)`;
  });
  if (moved.length) {
    void container.getBoundingClientRect();
    moved.forEach((r) => { r.style.transition = `transform ${String(duration)}ms var(--spring)`; r.style.transform = ''; });
    setTimeout(() => moved.forEach((r) => { r.style.transition = ''; }), duration + 60);
  }
  return true;
}

/** Eased number that follows `value` (counts toward each new value). */
export function useTweenedNumber(value: number, duration = 360, from?: number): number {
  const [shown, setShown] = useState(from ?? value);
  const current = useRef(from ?? value);
  useEffect(() => {
    const start = current.current;
    if (start === value || prefersReducedMotion()) { current.current = value; setShown(value); return; }
    let raf = 0;
    const t0 = performance.now();
    const run = (now: number): void => {
      const k = Math.min(1, (now - t0) / duration);
      const eased = duration > 600 ? 1 - Math.pow(2, -10 * k) : 1 - Math.pow(1 - k, 3);
      const next = k >= 1 ? value : Math.round(start + (value - start) * eased);
      current.current = next;
      setShown(next);
      if (k < 1) raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return shown;
}

/** Smoothly scrolls an element to `target` (ease-out cubic). Returns a cancel function. */
export function animateScroll(el: HTMLElement, target: number, duration = 640, done?: () => void): () => void {
  const from = el.scrollTop;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const to = Math.max(0, Math.min(max, target));
  if (prefersReducedMotion() || Math.abs(to - from) < 1) { el.scrollTop = to; done?.(); return () => {}; }
  const t0 = performance.now();
  let raf = requestAnimationFrame(function run(now) {
    const k = Math.min(1, (now - t0) / duration);
    el.scrollTop = from + (to - from) * (1 - Math.pow(1 - k, 3));
    if (k < 1) raf = requestAnimationFrame(run); else done?.();
  });
  return () => cancelAnimationFrame(raf);
}

/** Thin scrollbar thumb that appears while scrolling. Attach `onScroll` to the scroller. */
export function useScrollThumb(): { thumbRef: React.RefObject<HTMLDivElement | null>; onScroll: (e: React.UIEvent<HTMLElement>) => void } {
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onScroll = useCallback((e: React.UIEvent<HTMLElement>): void => {
    const c = e.currentTarget, th = thumbRef.current;
    if (!th) return;
    const ratio = c.clientHeight / c.scrollHeight;
    if (ratio >= 1) return;
    th.style.top = `${(c.scrollTop / c.scrollHeight * 100).toFixed(2)}%`;
    th.style.height = `${(ratio * 100).toFixed(2)}%`;
    th.style.opacity = '.5';
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { th.style.opacity = '0'; }, 900);
  }, []);
  return { thumbRef, onScroll };
}

// ── Layers ─────────────────────────────────────────────────────────────────
// A sheet in front pushes the page behind it back into depth. Pages read the
// count to dim their own panels; the header stays put.
let layerCount = 0;
const layerListeners = new Set<() => void>();
function emitLayers(): void { layerListeners.forEach((l) => l()); }
export function useLayerOpen(): boolean {
  return useSyncExternalStore(
    (l) => { layerListeners.add(l); return () => layerListeners.delete(l); },
    () => layerCount > 0,
  );
}
/** Registers an open sheet for as long as `open` is true. */
export function useLayer(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    layerCount++; emitLayers();
    return () => { layerCount--; emitLayers(); };
  }, [open]);
}

/** Alternates between two keyframe names so the same animation can replay. */
export function alt(base: string, n: number): string {
  return base + (n % 2 ? 'A' : 'B');
}
