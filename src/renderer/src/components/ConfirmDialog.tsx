import React, { useEffect, useRef } from 'react';
import './ConfirmDialog.css';

export interface ConfirmDialogRequest {
  mode: 'confirm' | 'alert';
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmDialogProps {
  request: ConfirmDialogRequest;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({ request, onConfirm, onCancel }) => {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { mode, danger } = request;

  useEffect(() => {
    const target = mode === 'confirm' && danger ? cancelRef.current : confirmRef.current;
    target?.focus();
  }, [mode, danger]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  const lines = request.message.split('\n');

  return (
    <div className="confirm-overlay" onMouseDown={onCancel} role="presentation">
      <div
        className={`confirm-dialog ${danger ? 'confirm-dialog--danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title ?? request.message}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {request.title && <div className="confirm-title">{request.title}</div>}
        <div className="confirm-message">
          {lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
        <div className="confirm-actions">
          {mode === 'confirm' && (
            <button ref={cancelRef} className="btn btn-sm confirm-btn-cancel" onClick={onCancel}>
              {request.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            ref={confirmRef}
            className={`btn btn-sm confirm-btn-confirm ${danger ? 'confirm-btn-confirm--danger' : ''}`}
            onClick={onConfirm}
          >
            {request.confirmLabel ?? (mode === 'alert' ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
