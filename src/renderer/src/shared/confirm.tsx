import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { ConfirmDialog, type ConfirmDialogRequest } from '../components/ConfirmDialog';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface AlertOptions {
  title?: string;
  message: string;
  okLabel?: string;
}

interface PendingRequest {
  request: ConfirmDialogRequest;
  resolve: (value: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
  alertDialog: (options: AlertOptions | string) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider');
  return ctx;
}

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [current, setCurrent] = useState<PendingRequest | null>(null);
  const queueRef = useRef<PendingRequest[]>([]);

  const enqueue = useCallback((entry: PendingRequest) => {
    setCurrent((active) => {
      if (active) {
        queueRef.current.push(entry);
        return active;
      }
      return entry;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setCurrent((active) => {
      active?.resolve(value);
      return queueRef.current.shift() ?? null;
    });
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions | string): Promise<boolean> => {
      const opts = typeof options === 'string' ? { message: options } : options;
      return new Promise((resolve) => {
        enqueue({
          request: {
            mode: 'confirm',
            title: opts.title,
            message: opts.message,
            confirmLabel: opts.confirmLabel,
            cancelLabel: opts.cancelLabel,
            danger: opts.danger,
          },
          resolve,
        });
      });
    },
    [enqueue],
  );

  const alertDialog = useCallback(
    (options: AlertOptions | string): Promise<void> => {
      const opts = typeof options === 'string' ? { message: options } : options;
      return new Promise((resolve) => {
        enqueue({
          request: {
            mode: 'alert',
            title: opts.title,
            message: opts.message,
            confirmLabel: opts.okLabel,
          },
          resolve: () => resolve(),
        });
      });
    },
    [enqueue],
  );

  return (
    <ConfirmContext.Provider value={{ confirm, alertDialog }}>
      {children}
      {current && (
        <ConfirmDialog
          request={current.request}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
};
