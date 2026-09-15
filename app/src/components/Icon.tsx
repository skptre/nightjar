import type { ReactNode } from 'react';
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
export function Brand(): ReactNode {
  return <span className="brand"><svg width="27" height="27" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="m4 7 12 5 12-5-7 13-5 6-5-6Z" stroke="currentColor" strokeWidth="1.4" />
    <path d="m4 7 12 11L28 7M16 18v8" stroke="currentColor" strokeWidth="1.4" /></svg>nightjar</span>;
}
