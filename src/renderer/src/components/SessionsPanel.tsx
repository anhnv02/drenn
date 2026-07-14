import { useState } from 'react';
import { relativeTime } from '../shared/relativeTime';
import type { ProjectGroup, Session, SessionSource } from '../../../shared/types';
import { Codicon } from './Codicon';
import './SessionsPanel.css';

const VISIBLE_LIMIT = 5;

const SOURCE_LABEL: Record<SessionSource, string> = {
  claude: 'C',
  opencode: 'O',
  copilot: 'GH',
  local: 'D',
};

function SourceBadge({ source }: { source: SessionSource }) {
  return (
    <span className={`source-badge source-badge-${source}`} title={source}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

interface Props {
  projects: ProjectGroup[];
  activeSessionId: string | null;
  runningSessions: Set<string>;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onNewProject: () => void;
  onDeleteSession: (sessionId: string) => void;
  width?: number;
}

function FolderIcon() {
  return <Codicon name="folder" size={12} className="folder-icon" />;
}

interface ProjectSectionProps {
  project: ProjectGroup;
  activeSessionId: string | null;
  runningSessions: Set<string>;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}

function ProjectSection({
  project,
  activeSessionId,
  runningSessions,
  onSelectSession,
  onDeleteSession,
}: ProjectSectionProps) {
  const [visibleCount, setVisibleCount] = useState(VISIBLE_LIMIT);
  const visibleSessions = project.sessions.slice(0, visibleCount);
  const hiddenCount = project.sessions.length - visibleSessions.length;

  return (
    <div className="project-group">
      <div className="section-title">
        <FolderIcon />
        <span>{project.name}</span>
      </div>
      {visibleSessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          active={session.id === activeSessionId}
          running={runningSessions.has(session.id)}
          onSelect={() => onSelectSession(session.id)}
          onDelete={() => onDeleteSession(session.id)}
        />
      ))}
      {hiddenCount > 0 && (
        <div className="more-sessions-row">
          <span
            className="more-sessions-link"
            onClick={() => setVisibleCount((count) => count + VISIBLE_LIMIT)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setVisibleCount((count) => count + VISIBLE_LIMIT);
              }
            }}
          >
            More ({hiddenCount})
          </span>
        </div>
      )}
    </div>
  );
}

function SessionItem({
  session,
  active,
  running,
  onSelect,
  onDelete,
}: {
  session: Session;
  active: boolean;
  running: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`session-item${active ? ' active' : ''}${running ? ' running' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="session-item-main">
        <div className="session-title-row">
          <SourceBadge source={session.source} />
          <span className="session-title">{session.title}</span>
          {session.source === 'local' && (
            <button
              className="icon-btn icon-btn-sm session-delete-btn"
              title="Delete session"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Codicon name="trash" size={12} />
            </button>
          )}
        </div>
        <div className="session-meta">
          {(session.added > 0 || session.removed > 0) && (
            <span className="session-stats">
              <span className="stat-added">+{session.added}</span>{' '}
              <span className="stat-removed">-{session.removed}</span>
            </span>
          )}
          <span className="session-time">{relativeTime(session.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

export function SessionsPanel({
  projects,
  activeSessionId,
  runningSessions,
  onSelectSession,
  onNewSession,
  onNewProject,
  onDeleteSession,
  width,
}: Props) {
  return (
    <div className="sessions-panel" style={width ? { width } : undefined}>
      <div className="sessions-toolbar">
        <span className="sessions-toolbar-title">Sessions</span>
        <div className="sessions-toolbar-actions">
          <button
            className="new-session-btn"
            title="New session in the active project"
            onClick={onNewSession}
          >
            New <span className="kbd">⌘N</span>
          </button>
          <button
            className="new-project-btn"
            title="Create a new project"
            onClick={onNewProject}
          >
            <Codicon name="add" size={12} /> Project
          </button>
        </div>
      </div>
      <div className="sessions-list">
        {projects.map((project) => (
          <ProjectSection
            key={project.name}
            project={project}
            activeSessionId={activeSessionId}
            runningSessions={runningSessions}
            onSelectSession={onSelectSession}
            onDeleteSession={onDeleteSession}
          />
        ))}
      </div>
    </div>
  );
}
