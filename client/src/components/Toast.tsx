import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

interface ToastApi {
  show: (message: string, tone?: ToastItem['tone']) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const show = useCallback((message: string, tone: ToastItem['tone'] = 'info') => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 5.5rem)' }}
      >
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`toast-in pointer-events-auto max-w-sm rounded-2xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ${
              t.tone === 'error'
                ? 'border-rose-400/30 bg-rose-950/80 text-rose-100'
                : 'border-white/15 bg-midnight-900/90 text-white'
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
