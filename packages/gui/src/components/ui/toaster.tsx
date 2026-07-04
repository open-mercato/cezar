'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn';
import { ToastContext, type ToastOptions, type ToastRecord, type ToastTone } from './use-toast';

const DEFAULT_DURATION_MS = 4000;

const TONE_CLASS: Record<ToastTone, string> = {
  default: 'border-outline-variant bg-surface-container-high text-on-surface',
  success: 'border-primary/40 bg-surface-container-high text-on-surface',
  error: 'border-error/40 bg-surface-container-high text-error',
};

/**
 * Unified toast container + provider (spec §3.6 / P10). Mount once (in
 * `AppShell`). Anchored bottom: on phone above the BottomTabBar
 * (`bottom-[calc(4rem+safe-area)]`) and bottom-right on `sm+`. On `z-toast`.
 * Auto-dismisses. Consumers call `useToast().toast(...)`.
 *
 * The two existing ad-hoc toasts (inbox, sync-indicator) migrate onto this in
 * a later phase — this provider is purely additive and side-effect free, so it
 * is safe to wrap the whole shell.
 */
export function Toaster({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const idRef = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string, opts?: ToastOptions): number => {
      const id = ++idRef.current;
      const durationMs = opts?.durationMs ?? DEFAULT_DURATION_MS;
      setToasts((prev) => [...prev, { id, message, tone: opts?.tone ?? 'default', durationMs }]);
      if (durationMs > 0) {
        const timer = setTimeout(() => dismiss(id), durationMs);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className={cn(
          'pointer-events-none fixed z-toast flex flex-col items-center gap-2',
          // Phone: full-width-ish, centered, above the BottomTabBar + safe area.
          'inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)] px-4',
          // Desktop: bottom-right, auto width.
          'sm:inset-x-auto sm:bottom-6 sm:right-6 sm:items-end sm:px-0',
        )}
        aria-live="polite"
        role="status"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto w-full max-w-sm rounded-md border px-3 py-2 text-sm shadow-ambient',
              'transition-opacity motion-reduce:transition-none',
              TONE_CLASS[t.tone],
            )}
            onClick={() => dismiss(t.id)}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
