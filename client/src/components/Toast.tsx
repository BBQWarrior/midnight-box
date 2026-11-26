import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action: ToastAction | undefined;
}

interface ToastApi {
  /** Shows a short message. With an action (e.g. Undo), it stays up longer. */
  show: (message: string, tone?: ToastItem['tone'], action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const SHOW_MS = 3500;
const SHOW_WITH_ACTION_MS = 7000;

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((prev) => prev.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (message: string, tone: ToastItem['tone'] = 'info', action?: ToastAction) => {
      const id = nextId.current++;
      // The same message again (e.g. two searches failing the same way) replaces the first one.
      setItems((prev) => [
        ...prev.filter((t) => t.message !== message || t.tone !== tone).slice(-2),
        { id, message, tone, action },
      ]);
      window.setTimeout(() => dismiss(id), action ? SHOW_WITH_ACTION_MS : SHOW_MS);
    },
    [dismiss],
  );

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
            className={`toast-in pointer-events-auto flex max-w-md items-center gap-3 rounded-lg border py-2.5 pl-4 text-sm shadow-lg shadow-black/40 ${
              t.action ? 'pr-2' : 'pr-4'
            } ${t.tone === 'error' ? 'border-danger/40 bg-[#2a1716] text-[#ffd9d6]' : 'border-line bg-raised text-ink'}`}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.onClick();
                }}
                className="min-h-9 shrink-0 rounded-md px-3 font-semibold text-accent hover:bg-accent-soft"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
