import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

export type ToastType = 'error' | 'warning' | 'success' | 'info';

export interface ToastInput {
  type: ToastType;
  title: string;
  message: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  durationMs?: number;
  dedupeKey?: string;
}

interface ToastItem extends ToastInput {
  id: string;
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const existingTimer = timersRef.current.get(id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (input: ToastInput): string => {
      const id = input.dedupeKey || `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      const existingTimer = timersRef.current.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timersRef.current.delete(id);
      }

      setToasts((prev) => {
        const filtered = prev.filter((t) => t.id !== id);
        return [...filtered, { ...input, id }].slice(-5);
      });

      const duration =
        input.durationMs !== undefined
          ? input.durationMs
          : input.type === 'error' || input.type === 'warning'
          ? 8500
          : 5000;

      if (duration > 0) {
        const timer = setTimeout(() => {
          dismissToast(id);
        }, duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismissToast]
  );

  return (
    <ToastContext.Provider value={{ showToast, dismissToast, clearToasts }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2.5 px-4 sm:px-0"
      >
        {toasts.map((t) => {
          const borderClass =
            t.type === 'error'
              ? 'border-red-300 dark:border-red-900'
              : t.type === 'warning'
              ? 'border-amber-300 dark:border-amber-800'
              : t.type === 'success'
              ? 'border-emerald-300 dark:border-emerald-900'
              : 'border-slate-200 dark:border-slate-700';

          const icon =
            t.type === 'error' ? (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
            ) : t.type === 'warning' ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            ) : t.type === 'success' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
            );

          return (
            <div
              key={t.id}
              role={t.type === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto flex items-start gap-3 rounded-xl border bg-white p-3.5 shadow-lg dark:bg-slate-900 ${borderClass}`}
            >
              {icon}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">{t.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">{t.message}</p>
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action?.onClick();
                      dismissToast(t.id);
                    }}
                    className="mt-2 inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
