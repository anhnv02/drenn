import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { buildFileTree, collectFolderPaths, type TreeNode } from './fileTree';
import { ChevronIcon, FileIcon, FolderIcon } from './TreeIcons';
import { ResizeHandle } from './ResizeHandle';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import type { FileChange } from '../../../shared/types';
import { api } from '../api';
import { useConfirm } from '../shared/confirm';
import './ChangesPanel.css';

const MIN_SECTION_HEIGHT = 60;
const DEFAULT_CURRENT_HEIGHT = 220;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

type Tab = 'changes' | 'files';

interface Props {
  files: FileChange[];
  currentFiles: FileChange[];
  treeFiles: FileChange[];
  sessionId?: string | null;
  onReverted?: () => void;
  onOpenDiff: (path: string, list: 'current' | 'session') => void;
  onOpenFile: (path: string) => void;
  width?: number;
}

function sumTotals(list: FileChange[]) {
  return list.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );
}

export function ChangesPanel({
  files,
  currentFiles,
  treeFiles,
  sessionId,
  onReverted,
  onOpenDiff,
  onOpenFile,
  width,
}: Props) {
  const [tab, setTab] = useState<Tab>('changes');
  const [reverting, setReverting] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; filePath: string } | null>(
    null,
  );
  const cachedCwd = useRef<string | null>(null);
  const { confirm, alertDialog } = useConfirm();

  const ensureCwd = useCallback(async () => {
    if (cachedCwd.current) return cachedCwd.current;
    if (!sessionId) return '';
    const cwd = await api.getSessionCwd(sessionId);
    cachedCwd.current = cwd;
    return cwd;
  }, [sessionId]);

  async function handleCopyAbsolutePath(filePath: string) {
    const cwd = await ensureCwd();
    const absolutePath = cwd ? `${cwd}/${filePath}` : filePath;
    await navigator.clipboard.writeText(absolutePath);
  }

  async function handleCopyRelativePath(filePath: string) {
    await navigator.clipboard.writeText(filePath);
  }

  function showContextMenu(e: React.MouseEvent, filePath: string) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, filePath });
  }

  function contextMenuItems(filePath: string): ContextMenuItem[] {
    return [
      { label: 'Copy Absolute Path', action: () => handleCopyAbsolutePath(filePath) },
      { label: 'Copy Relative Path', action: () => handleCopyRelativePath(filePath) },
    ];
  }

  async function handleRevert() {
    if (!sessionId || reverting) return;
    const ok = await confirm({
      title: 'Revert changes?',
      message:
        'Revert all file changes made in this session? Files the session created will be deleted.',
      confirmLabel: 'Revert',
      danger: true,
    });
    if (!ok) return;
    setReverting(true);
    try {
      const { report } = await api.revertSessionChanges(sessionId);
      const failed = report.filter((r) => r.action === 'failed');
      if (failed.length > 0) {
        await alertDialog({
          title: 'Some files could not be reverted',
          message: failed.map((f) => `${f.filePath}: ${f.error}`).join('\n'),
        });
      }
      onReverted?.();
    } finally {
      setReverting(false);
    }
  }
  const tree = useMemo(() => buildFileTree(treeFiles), [treeFiles]);
  const allFolderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(allFolderPaths));

  useEffect(() => {
    setCollapsed(new Set(allFolderPaths));
  }, [allFolderPaths]);

  useEffect(() => {
    cachedCwd.current = null;
  }, [sessionId]);
  const currentTotals = sumTotals(currentFiles);
  const sessionTotals = sumTotals(files);
  const [currentCollapsed, setCurrentCollapsed] = useState(false);
  const [sessionCollapsed, setSessionCollapsed] = useState(false);
  const [currentHeight, setCurrentHeight] = useState(DEFAULT_CURRENT_HEIGHT);

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderFileRow(file: FileChange, onClick: () => void) {
    return (
      <div
        key={file.path}
        className="list-item file-item"
        onClick={onClick}
        onContextMenu={(e) => showContextMenu(e, file.path)}
        title={file.path}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <FileIcon name={file.name} />
        <span className="file-name">{file.name}</span>
        <span className="file-dir">{file.dir}</span>
        <span className="file-stats">
          <span className="stat-added">+{file.added}</span>{' '}
          <span className="stat-removed">-{file.removed}</span>
        </span>
        <span className={`badge badge-${file.status}`}>{file.status}</span>
      </div>
    );
  }

  function renderSectionHeader(
    label: string,
    totals: { added: number; removed: number },
    collapsed: boolean,
    onToggle: () => void,
  ) {
    return (
      <div
        className="changes-section-header"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="changes-section-title">
          <ChevronIcon open={!collapsed} />
          {label}
        </span>
        <span className="changes-section-totals">
          <span className="stat-added">+{totals.added}</span>{' '}
          <span className="stat-removed">-{totals.removed}</span>
        </span>
      </div>
    );
  }

  function renderTree(node: TreeNode, depth: number) {
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={node.path}>
        {node.name && (
          <div
            className={`list-item tree-dir${node.name.startsWith('.') || node.ignored ? ' hidden-entry' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => toggle(node.path)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle(node.path);
              }
            }}
          >
            <ChevronIcon open={!isCollapsed} />
            <FolderIcon open={!isCollapsed} />
            <span className="file-name tree-folder-name">{node.name}</span>
          </div>
        )}
        {!isCollapsed && (
          <>
            {node.children.map((child) => renderTree(child, node.name ? depth + 1 : depth))}
            {node.files.map((file) => (
              <div
                key={file.path}
                className={`list-item file-item${file.name.startsWith('.') || file.ignored ? ' hidden-entry' : ''}`}
                style={{ paddingLeft: 8 + (node.name ? depth + 1 : depth) * 14 + 14 }}
                title={file.path}
                onClick={() => onOpenFile(file.path)}
                onContextMenu={(e) => showContextMenu(e, file.path)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenFile(file.path);
                  }
                }}
              >
                <FileIcon name={file.name} />
                <span className="file-name">{file.name}</span>
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="changes-panel" style={width ? { width } : undefined}>
      <div className="changes-tabs">
        <div className="tab-track">
          <button
            className={`changes-tab${tab === 'changes' ? ' active' : ''}`}
            onClick={() => setTab('changes')}
          >
            Changes
          </button>
          <button
            className={`changes-tab${tab === 'files' ? ' active' : ''}`}
            onClick={() => setTab('files')}
          >
            Files
          </button>
        </div>
        <span className="changes-totals">
          <span className="stat-added">+{currentTotals.added + sessionTotals.added}</span>
          <span className="stat-removed">-{currentTotals.removed + sessionTotals.removed}</span>
        </span>
        {tab === 'changes' && sessionId && files.length > 0 && (
          <button
            className="btn btn-sm changes-revert-btn"
            onClick={handleRevert}
            disabled={reverting}
            title="Restore every file this session touched to its pre-session state"
          >
            {reverting ? 'Reverting…' : <span className="codicon codicon-discard" />}
          </button>
        )}
      </div>

      <div className={`changes-list${tab === 'changes' ? ' changes-list-split' : ''}`}>
        {tab === 'changes' ? (
          <>
            <div
              className="changes-section"
              style={currentCollapsed ? undefined : { flex: `0 0 ${currentHeight}px` }}
            >
              {renderSectionHeader('Current', currentTotals, currentCollapsed, () =>
                setCurrentCollapsed((v) => !v),
              )}
              {!currentCollapsed && (
                <div className="changes-section-body">
                  {currentFiles.length === 0 ? (
                    <div className="changes-empty">No uncommitted changes</div>
                  ) : (
                    currentFiles.map((file) =>
                      renderFileRow(file, () => onOpenDiff(file.path, 'current')),
                    )
                  )}
                </div>
              )}
            </div>

            <ResizeHandle
              direction="vertical"
              className="changes-resize-handle"
              onResize={(delta) =>
                setCurrentHeight((h) => clamp(h + delta, MIN_SECTION_HEIGHT, 600))
              }
            />

            <div className="changes-section changes-section-fill">
              {renderSectionHeader('Session', sessionTotals, sessionCollapsed, () =>
                setSessionCollapsed((v) => !v),
              )}
              {!sessionCollapsed && (
                <div className="changes-section-body">
                  {files.length === 0 ? (
                    <div className="changes-empty">No changes in this session</div>
                  ) : (
                    files.map((file) => renderFileRow(file, () => onOpenDiff(file.path, 'session')))
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          renderTree(tree, 0)
        )}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems(contextMenu.filePath)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
