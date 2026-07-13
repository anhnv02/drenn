import type { Session } from '../../../shared/types';
import { Codicon } from './Codicon';
import './TitleBar.css';

interface Props {
  activeSession: Session | undefined;
  onOpenSettings: () => void;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}

export function TitleBar({
  activeSession,
  onOpenSettings,
  leftSidebarOpen,
  rightSidebarOpen,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  terminalOpen,
  onToggleTerminal,
}: Props) {
  return (
    <div className="titlebar">
      <div className="titlebar-traffic-light-spacer" />
      <div className="titlebar-nav" />
      <div className="titlebar-center">
        <div className="titlebar-pill">
          <span className="titlebar-pill-icon">
            <Codicon name="star-full" size={12} />
          </span>
          {activeSession ? (
            <span className="titlebar-pill-text">
              {activeSession.title} · {activeSession.projectName}
            </span>
          ) : (
            <span className="titlebar-pill-text titlebar-pill-placeholder">Drenn</span>
          )}
        </div>
      </div>
      <div className="titlebar-actions">
        <button
          type="button"
          className="icon-btn titlebar-icon-btn"
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <Codicon name="settings-gear" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn titlebar-icon-btn${terminalOpen ? ' active' : ''}`}
          title={terminalOpen ? 'Close terminal' : 'Open terminal'}
          aria-label={terminalOpen ? 'Close terminal' : 'Open terminal'}
          onClick={onToggleTerminal}
        >
          <Codicon name="terminal" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn titlebar-icon-btn${leftSidebarOpen ? ' active' : ''}`}
          title={leftSidebarOpen ? 'Hide left sidebar' : 'Show left sidebar'}
          aria-label={leftSidebarOpen ? 'Hide left sidebar' : 'Show left sidebar'}
          onClick={onToggleLeftSidebar}
        >
          <Codicon name="layout-panel-left" size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn titlebar-icon-btn${rightSidebarOpen ? ' active' : ''}`}
          title={rightSidebarOpen ? 'Hide right sidebar' : 'Show right sidebar'}
          aria-label={rightSidebarOpen ? 'Hide right sidebar' : 'Show right sidebar'}
          onClick={onToggleRightSidebar}
        >
          <Codicon name="layout-panel-right" size={16} />
        </button>
      </div>
    </div>
  );
}
