import { useEffect, useState } from 'react';
import { DiffEditor, Editor } from '@monaco-editor/react';
import { api } from '../api';
import type { DiffContent, DiffScope, FileChange } from '../../../shared/types';
import { Codicon } from './Codicon';
import './DiffModal.css';

type Mode = 'diff' | 'file';

interface Props {
  files: FileChange[];
  index: number;
  mode: Mode;
  scope?: DiffScope;
  sessionId: string | null;
  onNavigate: (index: number) => void;
  onClose: () => void;
}

export function DiffModal({ files, index, mode, scope, sessionId, onNavigate, onClose }: Props) {
  const file = files[index];
  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [sideBySide, setSideBySide] = useState(true);

  useEffect(() => {
    if (!file) return;
    setDiff(null);
    const effectiveScope = mode === 'file' ? 'disk' : (scope ?? 'session');
    api.getDiff(sessionId, file.path, effectiveScope).then((d) => {
      setDiff(d);
    });
  }, [file?.path, sessionId, mode, scope]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      if (e.key === 'ArrowRight' && index < files.length - 1) onNavigate(index + 1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, files.length]);

  if (!file) return null;

  return (
    <div className="diff-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="diff-card" onClick={(e) => e.stopPropagation()}>
        <div className="diff-card-header">
          {file.status && <span className={`badge badge-${file.status}`}>{file.status}</span>}
          <span className="diff-card-name">{file.name}</span>
          <span className="diff-card-dir">{file.dir}</span>
          {mode === 'diff' && diff?.source && (
            <span
              className="diff-source-badge"
              title={
                diff.source === 'session'
                  ? "Reconstructed from this session's edits (point-in-time)"
                  : 'Session log has no reconstructable edits for this file — showing HEAD vs the file on disk now'
              }
            >
              {diff.source === 'session' ? 'session edits' : 'vs HEAD (now)'}
            </span>
          )}
          <div className="diff-card-nav">
            <button
              className="icon-btn"
              disabled={index <= 0}
              onClick={() => onNavigate(index - 1)}
            >
              <Codicon name="chevron-left" size={14} />
            </button>
            <span className="diff-card-count">
              {index + 1} of {files.length}
            </span>
            <button
              className="icon-btn"
              disabled={index >= files.length - 1}
              onClick={() => onNavigate(index + 1)}
            >
              <Codicon name="chevron-right" size={14} />
            </button>
          </div>
          {mode === 'diff' && (
            <button
              className="btn btn-secondary btn-sm diff-layout-toggle"
              onClick={() => setSideBySide((prev) => !prev)}
              title={sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
              aria-label="Toggle diff layout"
            >
              {sideBySide ? 'Side by side' : 'Inline'}
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <Codicon name="close" size={14} />
          </button>
        </div>
        <div className="diff-card-body">
          {diff && mode === 'diff' && (
            <div className="diff-container">
              <DiffEditor
                original={diff.before}
                modified={diff.after}
                language={diff.language}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  renderSideBySide: sideBySide,
                }}
              />
            </div>
          )}
          {diff && mode === 'file' && (
            <Editor
              value={diff.after}
              language={diff.language}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
