import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Glyph } from './Icon';

export interface ToastAction { label: string; onClick: () => void }
export interface ToastOptions {
  /** A colored dot before the message, e.g. the stage color after a tracker move. */
  dot?: string;
  actions?: ToastAction[];
  duration?: number;
}
interface ToastItem extends ToastOptions {
  id: number;
  message: string;
  variant: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastItem['variant'], options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

let nextId = 0;

// One confirmation at a time, bottom center. A new toast replaces the old one.
export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [item, setItem] = useState<ToastItem | null>(null);
  const addToast = useCallback((message: string, variant: ToastItem['variant'] = 'success', options: ToastOptions = {}) => {
    setItem({ id: nextId++, message, variant, ...options });
  }, []);
  const remove = useCallback((id: number) => setItem((current) => current?.id === id ? null : current), []);
  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {item && <ToastPill key={item.id} item={item} onDone={remove} />}
      </div>
    </ToastContext.Provider>
  );
}

function ToastPill({ item, onDone }: { item: ToastItem; onDone: (id: number) => void }): ReactNode {
  const [leaving, setLeaving] = useState(false);
  const hover = useRef(false);
  const duration = item.duration ?? (item.actions?.length ? 5200 : 3200);
  useEffect(() => {
    let leave: ReturnType<typeof setTimeout>;
    let done: ReturnType<typeof setTimeout>;
    const schedule = (ms: number): void => {
      leave = setTimeout(() => {
        if (hover.current) { schedule(1200); return; }
        setLeaving(true);
        done = setTimeout(() => onDone(item.id), 300);
      }, ms);
    };
    schedule(duration);
    return () => { clearTimeout(leave); clearTimeout(done); };
  }, [item.id, duration, onDone]);
  const dot = item.dot ?? (item.variant === 'error' ? 'var(--danger)' : null);
  return (
    <div className={`toast ${item.actions?.length ? 'has-actions' : ''} ${leaving ? 'leaving' : ''}`} role="status"
      onMouseEnter={() => { hover.current = true; }} onMouseLeave={() => { hover.current = false; }}>
      {dot ? <span className="stdot" style={{ background: dot }} />
        : item.variant === 'success' && !item.actions?.length ? <Glyph name="check" size={13} width={1.9} /> : null}
      <span className="msg">{item.message}</span>
      {item.actions?.map((action) => <button key={action.label} type="button" className="tbtn"
        onClick={() => { action.onClick(); setLeaving(true); setTimeout(() => onDone(item.id), 300); }}>{action.label}</button>)}
    </div>
  );
}
