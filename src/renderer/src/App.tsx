import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api';
import { TitleBar } from './components/TitleBar';
import { SessionsPanel } from './components/SessionsPanel';
import { ChatPanel } from './components/ChatPanel';
import { ChangesPanel } from './components/ChangesPanel';
import { DiffModal } from './components/DiffModal';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { TerminalPanel } from './components/TerminalPanel';
import { ResizeHandle } from './components/ResizeHandle';
import { ToastStack, type ToastItem } from './components/Toast';
import type { TerminalInstance } from './components/terminalTypes';
import type { FileChange, ProjectGroup } from '../../shared/types';
import './App.css';

const MIN_LEFT_WIDTH = 180;
const MAX_LEFT_WIDTH = 500;
const MIN_RIGHT_WIDTH = 200;
const MAX_RIGHT_WIDTH = 600;
const MIN_TERMINAL_HEIGHT = 100;
const MIN_CHAT_HEIGHT = 0;
const TERMINAL_SNAP_THRESHOLD = 100;

let terminalCounter = 0;

export function App() {
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [currentFiles, setCurrentFiles] = useState<FileChange[]>([]);
  const [treeFiles, setTreeFiles] = useState<FileChange[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [modal, setModal] = useState<{
    path: string;
    mode: 'diff' | 'file';
    list: 'current' | 'session' | 'tree';
  } | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(300);
  const [terminalHeight, setTerminalHeight] = useState(250);
  const [terminalMaximized, setTerminalMaximized] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminals, setTerminals] = useState<TerminalInstance[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());
  const appCenterRef = useRef<HTMLDivElement>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await api.deleteSession(sessionId);
      setProjects((prev) =>
        prev
          .map((project) => ({
            ...project,
            sessions: project.sessions.filter((s) => s.id !== sessionId),
          }))
          .filter((project) => project.sessions.length > 0),
      );
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
    [activeSessionId],
  );

  useEffect(() => {
    api.getSessions().then(({ projects, activeSessionId }) => {
      setProjects(projects);
      setActiveSessionId(activeSessionId);
    });
  }, []);

  useEffect(() => {
    return api.onAgentEvent((event) => {
      if (
        (event.type === 'tool_result' || event.type === 'done') &&
        typeof event.sessionId === 'string' &&
        !event.sessionId.includes(':sub:') &&
        /^(local|claude|opencode|copilot):/.test(event.sessionId)
      ) {
        api.getSessions().then(({ projects }) => {
          setProjects(projects);
          setActiveSessionId((prev) => {
            if (prev === null) return null;
            const exists = projects.some((p) => p.sessions.some((s) => s.id === prev));
            return exists ? prev : (projects[0]?.sessions[0]?.id ?? null);
          });
        });
      }
    });
  }, []);

  useEffect(() => {
    return api.onBackgroundJob((payload) => {
      const id = `job-${payload.jobId}-${Date.now()}`;
      const message =
        payload.status === 'error'
          ? `Background task failed: ${payload.error || 'unknown error'}`
          : payload.status === 'cancelled'
            ? 'Background task cancelled'
            : 'Background task finished';
      setToasts((prev) => [
        ...prev,
        { id, message, tone: payload.status === 'error' ? 'error' : 'success' },
      ]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 6000);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const start = Date.now();
    setFilesLoading(true);
    api.getChanges(activeSessionId).then(({ files, current }) => {
      if (!cancelled) {
        setFiles(files);
        setCurrentFiles(current);
      }
    });
    api.getFiles(activeSessionId).then(async ({ files }) => {
      const elapsed = Date.now() - start;
      if (elapsed < 1500) await new Promise((r) => setTimeout(r, 1500 - elapsed));
      if (!cancelled) {
        setTreeFiles(files);
        setFilesLoading(false);
      }
    });
    setModal(null);
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  const refreshChanges = useCallback((sessionId: string) => {
    api.getChanges(sessionId).then(({ files, current }) => {
      if (activeSessionIdRef.current === sessionId) {
        setFiles(files);
        setCurrentFiles(current);
      }
    });
    const start = Date.now();
    setFilesLoading(true);
    api.getFiles(sessionId).then(async ({ files }) => {
      const elapsed = Date.now() - start;
      if (elapsed < 1500) await new Promise((r) => setTimeout(r, 1500 - elapsed));
      if (activeSessionIdRef.current === sessionId) {
        setTreeFiles(files);
        setFilesLoading(false);
      }
    });
  }, []);

  const activeSession = projects
    .flatMap((project) => project.sessions)
    .find((session) => session.id === activeSessionId);

  const handleNewSession = useCallback(async () => {
    const activeProject = projects.find((project) =>
      project.sessions.some((session) => session.id === activeSessionId),
    );
    if (!activeProject || !activeSessionId) return;
    const session = await api.createSession(activeProject.name, activeSessionId);
    setProjects((prev) => {
      const rest = prev.filter((project) => project.name !== activeProject.name);
      const updated = { ...activeProject, sessions: [session, ...activeProject.sessions] };
      return [updated, ...rest];
    });
    setActiveSessionId(session.id);
  }, [projects, activeSessionId]);

  const handleNewProject = useCallback(async () => {
    const result = await api.openDirectory();
    if (result.cancelled || !result.path) return;
    const projectName = result.path.split('/').pop() || result.path;
    const session = await api.createSession(projectName, '', result.path);
    const newProject = {
      name: projectName,
      sessions: [session],
    };
    setProjects((prev) => [newProject, ...prev]);
    setActiveSessionId(session.id);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewSession();
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ',') {
        e.preventDefault();
        setSettingsTab('providers');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleNewSession]);

  const modalFiles =
    modal?.list === 'tree' ? treeFiles : modal?.list === 'current' ? currentFiles : files;
  const modalIndex = modal ? modalFiles.findIndex((file) => file.path === modal.path) : -1;

  const addTerminal = useCallback(() => {
    terminalCounter++;
    const newTerminal: TerminalInstance = {
      id: `terminal-${Date.now()}`,
      name: `Terminal ${terminalCounter}`,
      sessionId: activeSessionId,
    };
    setTerminals((prev) => [...prev, newTerminal]);
    setActiveTerminalId(newTerminal.id);
    setTerminalOpen(true);
  }, [activeSessionId]);

  const removeTerminal = useCallback(
    (terminalId: string) => {
      setTerminals((prev) => {
        const next = prev.filter((t) => t.id !== terminalId);
        if (next.length === 0) {
          setTerminalOpen(false);
          setActiveTerminalId(null);
        } else if (activeTerminalId === terminalId) {
          setActiveTerminalId(next[next.length - 1].id);
        }
        return next;
      });
    },
    [activeTerminalId],
  );

  const handleToggleTerminal = useCallback(() => {
    if (terminalOpen) {
      setTerminalOpen(false);
    } else {
      if (terminals.length === 0) {
        addTerminal();
      } else {
        setTerminalOpen(true);
      }
    }
  }, [terminalOpen, terminals.length, addTerminal]);

  const handleLeftResize = useCallback((delta: number) => {
    setLeftWidth((prev) => Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, prev + delta)));
  }, []);

  const handleRightResize = useCallback((delta: number) => {
    setRightWidth((prev) => Math.min(MAX_RIGHT_WIDTH, Math.max(MIN_RIGHT_WIDTH, prev - delta)));
  }, []);

  const handleTerminalResize = useCallback((delta: number) => {
    setTerminalHeight((prev) => {
      const containerHeight = appCenterRef.current?.clientHeight ?? prev;
      const maxHeight = Math.max(MIN_TERMINAL_HEIGHT, containerHeight - MIN_CHAT_HEIGHT);
      const next = Math.min(maxHeight, Math.max(MIN_TERMINAL_HEIGHT, prev - delta));
      const snapping = delta < 0 && maxHeight - next <= TERMINAL_SNAP_THRESHOLD;
      return snapping ? maxHeight : next;
    });
  }, []);

  useEffect(() => {
    const clamp = () => {
      const containerHeight = appCenterRef.current?.clientHeight;
      if (!containerHeight) return;
      setTerminalHeight((prev) =>
        Math.min(prev, Math.max(MIN_TERMINAL_HEIGHT, containerHeight - MIN_CHAT_HEIGHT)),
      );
    };
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  const handleTerminalMaximize = useCallback(() => {
    setTerminalMaximized((prev) => !prev);
  }, []);

  return (
    <div className="app">
      <TitleBar
        activeSession={activeSession}
        onOpenSettings={() => setSettingsTab('providers')}
        leftSidebarOpen={leftSidebarOpen}
        rightSidebarOpen={rightSidebarOpen}
        onToggleLeftSidebar={() => setLeftSidebarOpen(!leftSidebarOpen)}
        onToggleRightSidebar={() => setRightSidebarOpen(!rightSidebarOpen)}
        terminalOpen={terminalOpen}
        onToggleTerminal={handleToggleTerminal}
      />
      <div className="app-body">
        {leftSidebarOpen && (
          <SessionsPanel
            projects={projects}
            activeSessionId={activeSessionId}
            runningSessions={runningSessions}
            onSelectSession={setActiveSessionId}
            onNewSession={handleNewSession}
            onNewProject={handleNewProject}
            onDeleteSession={handleDeleteSession}
            width={leftWidth}
          />
        )}
        {leftSidebarOpen && <ResizeHandle direction="horizontal" onResize={handleLeftResize} />}
        <div className="app-center" ref={appCenterRef}>
          <ChatPanel
            session={activeSession}
            runningSessions={runningSessions}
            onRunningSessionsChange={setRunningSessions}
            onToolResult={refreshChanges}
          />
          {terminalOpen && terminals.length > 0 && (
            <>
              <ResizeHandle
                direction="vertical"
                onResize={handleTerminalResize}
                onDoubleClick={handleTerminalMaximize}
              />
              <TerminalPanel
                terminals={terminals}
                activeTerminalId={activeTerminalId}
                onSelectTerminal={setActiveTerminalId}
                onClose={() => {
                  setTerminalOpen(false);
                  setTerminalMaximized(false);
                }}
                onCloseTerminal={removeTerminal}
                onAddTerminal={addTerminal}
                height={terminalMaximized ? undefined : terminalHeight}
                maximized={terminalMaximized}
                onMaximize={handleTerminalMaximize}
              />
            </>
          )}
        </div>
        {rightSidebarOpen && <ResizeHandle direction="horizontal" onResize={handleRightResize} />}
        {rightSidebarOpen && (
          <ChangesPanel
            files={files}
            currentFiles={currentFiles}
            treeFiles={treeFiles}
            filesLoading={filesLoading}
            sessionId={activeSessionId}
            onReverted={() => activeSessionId && refreshChanges(activeSessionId)}
            onOpenDiff={(path, list) => setModal({ path, mode: 'diff', list })}
            onOpenFile={(path) => setModal({ path, mode: 'file', list: 'tree' })}
            width={rightWidth}
          />
        )}
      </div>
      {modalIndex >= 0 && modal && (
        <DiffModal
          files={modalFiles}
          index={modalIndex}
          mode={modal.mode}
          scope={modal.list === 'current' ? 'disk' : undefined}
          sessionId={activeSessionId}
          onNavigate={(i) =>
            setModal(
              modalFiles[i]
                ? { path: modalFiles[i].path, mode: modal.mode, list: modal.list }
                : null,
            )
          }
          onClose={() => setModal(null)}
        />
      )}
      {settingsTab && (
        <SettingsModal
          initialTab={settingsTab}
          sessionId={activeSessionId}
          onClose={() => setSettingsTab(null)}
        />
      )}
      <ToastStack
        toasts={toasts}
        onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))}
      />
    </div>
  );
}
