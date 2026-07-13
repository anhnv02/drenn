import React, { useState, useRef, useEffect } from 'react';
import type { PermissionRequestPayload, PermissionResponsePayload } from '../../../shared/ipc';
import { Markdown } from '../shared/Markdown';
import './PermissionDialog.css';

export type PermissionDialogResponse = Omit<PermissionResponsePayload, 'requestId'>;

interface PermissionDialogProps {
  request: PermissionRequestPayload;
  onRespond: (response: PermissionDialogResponse) => void;
}

const NEVER_REMEMBER = new Set(['exit_plan', 'apply_patch']);

function bashPrefix(command: string): string | null {
  const trimmed = command.trim();
  if (/[|&;`]|\$\(|<\(|>/.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return null;
  return tokens[1].startsWith('-') ? tokens[0] : `${tokens[0]} ${tokens[1]}`;
}

function urlOriginPrefix(resource: string): string | null {
  try {
    return new URL(resource).origin + '/';
  } catch {
    return null;
  }
}

export const PermissionDialog: React.FC<PermissionDialogProps> = ({ request, onRespond }) => {
  const [denying, setDenying] = useState(false);
  const [feedback, setFeedback] = useState('');
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const [allowMenuOpen, setAllowMenuOpen] = useState(false);
  const allowMenuRef = useRef<HTMLDivElement>(null);

  const isPlan = request.toolName === 'exit_plan';

  useEffect(() => {
    if (denying) feedbackRef.current?.focus();
  }, [denying]);

  useEffect(() => {
    setDenying(false);
    setFeedback('');
    setAllowMenuOpen(false);
  }, [request.id]);

  useEffect(() => {
    if (!allowMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (allowMenuRef.current && !allowMenuRef.current.contains(e.target as Node)) {
        setAllowMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAllowMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [allowMenuOpen]);

  function approve(remember: boolean, updatedMode?: 'default' | 'acceptEdits') {
    setAllowMenuOpen(false);
    onRespond({ approved: true, remember, updatedMode });
  }

  function approvePrefix(prefix: string) {
    setAllowMenuOpen(false);
    onRespond({ approved: true, remember: true, rememberPrefix: prefix });
  }

  function deny() {
    const text = feedback.trim();
    onRespond({ approved: false, remember: false, feedback: text || undefined });
  }

  function handleFeedbackKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      deny();
    }
    if (e.key === 'Escape') {
      setDenying(false);
    }
  }

  const getToolIcon = (toolName: string): string => {
    switch (toolName) {
      case 'edit':
        return 'edit';
      case 'write':
        return 'file-add';
      case 'bash':
        return 'terminal';
      case 'fetch':
        return 'globe';
      case 'view':
        return 'eye';
      case 'exit_plan':
        return 'checklist';
      default:
        return 'shield';
    }
  };

  const getToolColor = (toolName: string): string => {
    switch (toolName) {
      case 'edit':
        return '#4ec9b0';
      case 'write':
        return '#569cd6';
      case 'bash':
        return '#dcdcaa';
      case 'fetch':
        return '#c586c0';
      case 'view':
        return '#9cdcfe';
      case 'exit_plan':
        return '#569cd6';
      default:
        return '#808080';
    }
  };

  const feedbackForm = (
    <div className="permission-feedback">
      <textarea
        ref={feedbackRef}
        className="permission-feedback-input"
        placeholder={
          isPlan
            ? 'What should change in the plan? (optional)'
            : 'Tell the agent what to do instead (optional)'
        }
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        onKeyDown={handleFeedbackKeyDown}
        rows={2}
      />
      <div className="permission-inline-actions">
        <button className="btn btn-sm permission-btn-deny" onClick={() => setDenying(false)}>
          Back
        </button>
        <button
          className="btn btn-sm permission-btn-deny permission-btn-deny-confirm"
          onClick={deny}
        >
          {isPlan ? 'Keep planning' : 'Deny'}
        </button>
      </div>
    </div>
  );

  if (isPlan) {
    const plan = typeof request.params?.plan === 'string' ? request.params.plan : '';
    return (
      <div className="permission-inline">
        <div className="permission-inline-header">
          <div
            className="permission-inline-icon"
            style={{ backgroundColor: getToolColor(request.toolName) }}
          >
            <span className="codicon codicon-checklist" />
          </div>
          <div className="permission-inline-info">
            <span className="permission-inline-tool">Ready to code?</span>
            <span className="permission-inline-desc">
              The agent finished planning and wants to start implementing.
            </span>
          </div>
        </div>

        {plan && (
          <div className="permission-plan">
            <Markdown text={plan} />
          </div>
        )}

        {denying ? (
          feedbackForm
        ) : (
          <div className="permission-inline-footer">
            <div className="permission-inline-actions">
              <button className="btn btn-sm permission-btn-deny" onClick={() => setDenying(true)}>
                No, keep planning
              </button>
              <button
                className="btn btn-sm permission-btn-allow permission-btn-secondary"
                onClick={() => approve(false, 'default')}
              >
                Yes, manually approve edits
              </button>
              <button
                className="btn btn-sm permission-btn-allow"
                onClick={() => approve(false, 'acceptEdits')}
              >
                Yes, auto-accept edits
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const canRemember = !NEVER_REMEMBER.has(request.toolName);
  const prefix =
    request.toolName === 'bash'
      ? bashPrefix(request.resource)
      : request.toolName === 'fetch'
        ? urlOriginPrefix(request.resource)
        : null;
  const prefixLabel =
    request.toolName === 'bash' ? `Always allow “${prefix} …”` : `Always allow ${prefix}`;
  const exactLabel =
    request.toolName === 'bash'
      ? 'Always allow this exact command'
      : request.toolName === 'fetch'
        ? 'Always allow this exact URL'
        : 'Always Allow';

  return (
    <div className="permission-inline">
      <div className="permission-inline-header">
        <div
          className="permission-inline-icon"
          style={{ backgroundColor: getToolColor(request.toolName) }}
        >
          <span className={`codicon codicon-${getToolIcon(request.toolName)}`} />
        </div>
        <div className="permission-inline-info">
          <span className="permission-inline-tool">{request.toolName}</span>
          {request.description && (
            <span className="permission-inline-desc">{request.description}</span>
          )}
        </div>
      </div>

      {request.external && (
        <div className="permission-inline-warning">
          <span className="codicon codicon-warning" />
          Outside the project directory
        </div>
      )}

      {request.path && (
        <div className="permission-inline-path">
          <span className="codicon codicon-file" />
          {request.path}
        </div>
      )}

      {request.diff && <pre className="permission-inline-diff">{request.diff}</pre>}

      {denying ? (
        feedbackForm
      ) : (
        <div className="permission-inline-footer">
          <div className="permission-inline-footer-row permission-inline-footer-row--deny">
            <button className="btn btn-sm permission-btn-deny" onClick={() => setDenying(true)}>
              Deny
            </button>
          </div>
          <div className="permission-inline-footer-row permission-inline-footer-row--allow">
            {canRemember ? (
              <div className="permission-allow-split" ref={allowMenuRef}>
                <button
                  className="btn btn-sm permission-btn-allow permission-btn-allow-main"
                  onClick={() => approve(false)}
                >
                  Allow
                </button>
                <button
                  className="btn btn-sm permission-btn-allow permission-btn-allow-caret"
                  aria-label="Always allow options"
                  aria-expanded={allowMenuOpen}
                  onClick={() => setAllowMenuOpen((v) => !v)}
                >
                  <span className="codicon codicon-chevron-up" />
                </button>
                {allowMenuOpen && (
                  <div className="permission-allow-menu" role="menu">
                    {prefix && (
                      <button
                        className="permission-allow-menu-item"
                        role="menuitem"
                        title={prefixLabel}
                        onClick={() => approvePrefix(prefix)}
                      >
                        {prefixLabel}
                      </button>
                    )}
                    <button
                      className="permission-allow-menu-item"
                      role="menuitem"
                      title={exactLabel}
                      onClick={() => approve(true)}
                    >
                      {exactLabel}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button className="btn btn-sm permission-btn-allow" onClick={() => approve(false)}>
                Allow
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
