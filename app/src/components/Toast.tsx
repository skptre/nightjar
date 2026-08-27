import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  variant: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastItem['variant']) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((message: string, variant: ToastItem['variant'] = 'success') => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, variant }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <ToastNotification key={t.id} item={t} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastNotification({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}): ReactNode {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), 3000);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  const variantStyles: Record<ToastItem['variant'], string> = {
    success: 'bg-emerald-600 dark:bg-emerald-700',
    error: 'bg-red-600 dark:bg-red-700',
    info: 'bg-gray-700 dark:bg-nj-surface-2 dark:border dark:border-nj-border-bright',
  };

  const iconPath: Record<ToastItem['variant'], string> = {
    success: 'M5 13l4 4L19 7',
    error: 'M6 18L18 6M6 6l12 12',
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  };

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-white text-sm ${variantStyles[item.variant]}`}
      role="status"
    >
      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d={iconPath[item.variant]} />
      </svg>
      <span>{item.message}</span>
    </div>
  );
}
