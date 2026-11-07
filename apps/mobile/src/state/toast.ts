import { create } from 'zustand';
import { uid } from '../lib/ids';

export type ToastKind = 'info' | 'success' | 'error';
export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
  actionLabel?: string;
  onAction?: () => void;
  shownAt: number;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, kind?: ToastKind, opts?: { actionLabel?: string; onAction?: () => void; durationMs?: number }) => void;
  dismiss: (id: string) => void;
  /** drop toasts older than `ms` — used on navigation so a stale error does not follow the user onto the next screen */
  dismissOlderThan: (ms: number) => void;
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message, kind = 'info', opts = {}) => {
    const id = uid('t');
    const toast: Toast = { id, message, kind, actionLabel: opts.actionLabel, onAction: opts.onAction, shownAt: Date.now() };
    set((s) => ({ toasts: [...s.toasts.slice(-2), toast] }));
    setTimeout(() => get().dismiss(id), opts.durationMs ?? (kind === 'error' ? 6000 : 3500));
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  dismissOlderThan: (ms) => {
    const cutoff = Date.now() - ms;
    set((s) => (s.toasts.some((t) => t.shownAt < cutoff) ? { toasts: s.toasts.filter((t) => t.shownAt >= cutoff) } : s));
  },
}));

export const toast = {
  info: (m: string) => useToast.getState().show(m, 'info'),
  success: (m: string) => useToast.getState().show(m, 'success'),
  error: (m: string, opts?: { actionLabel?: string; onAction?: () => void }) => useToast.getState().show(m, 'error', opts),
};
