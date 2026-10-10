import type { ReactNode } from 'react';

// Legacy 24px outline icons, still used by a few older screens.
const paths = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  jobs: 'M8 6V4h8v2M3 7h18v13H3ZM3 12c5 3 13 3 18 0M10 13h4',
  tracker: 'M3 4h18v16H3ZM3 9h18M8 9v11M15 9v11',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  external: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
  close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 5v14M5 12h14',
  check: 'm5 12 4 4L19 6',
  bookmark: 'M6 3h12v18l-6-4-6 4Z',
  watch: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  bell: 'M18 8a6 6 0 0 0-12 0c0 8-3 8-3 10h18c0-2-3-2-3-10M10 21h4',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z',
  pin: 'M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 1 1 14 0ZM14 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
} as const;
export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

// 16px glyphs from the design, drawn on a 16-unit grid.
const glyphs = {
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5L14 14',
  user: 'M8 8.25a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.75 14c.8-2.6 2.9-4 5.25-4s4.45 1.4 5.25 4',
  go: 'M3 8h10M9 4l4 4-4 4',
  ext: 'M5 11l6-6M6 5h5v5',
  prev: 'M10 3L5 8l5 5',
  next: 'M6 3l5 5-5 5',
  down: 'M4 6l4 4 4-4',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  check: 'M3 8.5l3.2 3L13 4.5',
  bookmark: 'M4.5 2.5h7a.5.5 0 0 1 .5.5v10.5l-4-2.75-4 2.75V3a.5.5 0 0 1 .5-.5z',
  lines: 'M3 4.5h10M3 8h10M3 11.5h6',
  clock: 'M8 4.5V8l2.5 1.5M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z',
  spin: 'M8 2a6 6 0 1 1-6 6',
  watch: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  sliders: 'M3 5h6M11 5h2M3 11h2M7 11h6M9 3.5v3M5 9.5v3',
  download: 'M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10',
  flag: 'M3.5 14V2.5M3.5 3h8l-1.5 3 1.5 3h-8',
} as const;
export type GlyphName = keyof typeof glyphs;
export function Glyph({ name, size = 16, width = 1.6, className, style }: {
  name: GlyphName; size?: number; width?: number; className?: string; style?: React.CSSProperties;
}): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={width}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}><path d={glyphs[name]} /></svg>;
}

/** The nightjar mark: two wings meeting in a point. */
export const WINGS = 'M3 17.5C12.5 16.9 19.4 20.6 24 30C28.6 20.6 35.5 16.9 45 17.5C36.8 20.4 30.4 26.7 24 39C17.6 26.7 11.2 20.4 3 17.5Z';
export function Mark({ size = 24 }: { size?: number }): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"><path d={WINGS} fill="currentColor" /></svg>;
}
export function Brand(): ReactNode {
  return <span className="nj-brand"><Mark /><span>Nightjar</span></span>;
}
