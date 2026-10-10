import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/platform';
import { prefersReducedMotion } from '@/motion/motion';
import { WINGS } from './Icon';
import '@/styles/startup-morph.css';

// Launch sequence: the mark flaps in, the wordmark writes itself out, then the
// lockup docks into the header logo while Home rises underneath.
const DOCK_AT = 3700;
const HOME_AT = 3950;
const LOGO_AT = 4560;
const DONE_AT = 4950;
const SEEN_KEY = 'nj.booted';

/** Desktop app launches only, once per session. `?startup` forces it for previews. */
export function shouldPlayStartup(): boolean {
  try {
    const forced = new URLSearchParams(window.location.search).has('startup');
    if (!forced && (!isTauri() || sessionStorage.getItem(SEEN_KEY) === '1')) return false;
    if (prefersReducedMotion()) return false;
    sessionStorage.setItem(SEEN_KEY, '1');
    return true;
  } catch { return false; }
}

export function Startup({ onDone }: { onDone: () => void }): React.ReactNode {
  const lockRef = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (): void => { setGone(true); onDone(); };
    timers.push(setTimeout(() => {
      const lock = lockRef.current;
      const brand = document.querySelector('.nj-brand');
      if (!lock || !brand) return;
      const a = lock.getBoundingClientRect(), b = brand.getBoundingClientRect();
      if (!a.width || !b.width) return;
      const s = b.width / a.width;
      const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
      const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      lock.animate([{ transform: 'none' }, { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(3)})` }],
        { duration: 900, easing: 'cubic-bezier(.65,0,.2,1)', fill: 'forwards' });
    }, DOCK_AT));
    timers.push(setTimeout(() => lockRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }), LOGO_AT));
    timers.push(setTimeout(finish, DONE_AT));
    // Any key or click skips straight to the app.
    const skip = (): void => { timers.forEach(clearTimeout); finish(); };
    window.addEventListener('keydown', skip, { once: true });
    window.addEventListener('pointerdown', skip, { once: true });
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [onDone]);
  if (gone) return null;
  return <div className="boot" aria-hidden="true">
    <div ref={lockRef} className="boot-lock">
      <div className="wing"><svg width="120" height="120" viewBox="0 0 48 48"><path d={WINGS} fill="currentColor" /></svg></div>
      <span className="word">Nightjar</span>
    </div>
  </div>;
}

export const STARTUP_VARS = { '--home-at': `${String(HOME_AT)}ms`, '--logo-at': `${String(LOGO_AT)}ms` } as React.CSSProperties;
