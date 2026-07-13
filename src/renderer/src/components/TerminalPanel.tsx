import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { Codicon } from './Codicon';
import type { TerminalInstance } from './terminalTypes';
import './TerminalPanel.css';

interface TerminalState {
  instance: TerminalInstance;
  terminal: Terminal;
  fitAddon: FitAddon;
  ptyId: string;
  disposableData: () => void;
  disposableExit: () => void;
}

interface Props {
  terminals: TerminalInstance[];
  activeTerminalId: string | null;
  onSelectTerminal: (id: string) => void;
  onClose: () => void;
  onCloseTerminal: (id: string) => void;
  onAddTerminal: () => void;
  height?: number;
  maximized?: boolean;
  onMaximize?: () => void;
}

export function TerminalPanel({
  terminals,
  activeTerminalId,
  onSelectTerminal,
  onClose,
  onCloseTerminal,
  onAddTerminal,
  height,
  maximized,
  onMaximize,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalsMapRef = useRef<Map<string, TerminalState>>(new Map());
  const [initialized, setInitialized] = useState(false);

  const handleResize = useCallback(() => {
    const active = activeTerminalId ? terminalsMapRef.current.get(activeTerminalId) : null;
    if (active) {
      active.fitAddon.fit();
      api.resizeTerminal(active.ptyId, active.terminal.cols, active.terminal.rows);
    }
  }, [activeTerminalId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const map = terminalsMapRef.current;

    const createTerminalElement = async (instance: TerminalInstance) => {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: '#1e1e1e',
          foreground: '#cccccc',
          cursor: '#ffffff',
          selectionBackground: '#264f78',
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const wrapper = document.createElement('div');
      wrapper.className = 'terminal-instance';
      wrapper.dataset.terminalId = instance.id;
      term.open(wrapper);
      fitAddon.fit();

      const { cols, rows } = term;
      const { id: ptyId } = await api.createTerminal(instance.sessionId, cols, rows);

      term.onData((data) => {
        api.writeTerminal(ptyId, data);
      });

      const disposableData = api.onTerminalData((payload) => {
        if (payload.id === ptyId) {
          term.write(payload.data);
        }
      });

      const disposableExit = api.onTerminalExit((payload) => {
        if (payload.id === ptyId) {
          term.write('\r\n[Process exited]');
        }
      });

      const state: TerminalState = {
        instance,
        terminal: term,
        fitAddon,
        ptyId,
        disposableData,
        disposableExit,
      };

      map.set(instance.id, state);
      container.appendChild(wrapper);

      if (instance.id === activeTerminalId) {
        wrapper.style.display = 'block';
        fitAddon.fit();
        term.focus();
      } else {
        wrapper.style.display = 'none';
      }
    };

    terminals.forEach((t) => {
      if (!map.has(t.id)) {
        createTerminalElement(t);
      }
    });

    for (const [id, state] of map) {
      if (!terminals.find((t) => t.id === id)) {
        state.disposableData();
        state.disposableExit();
        api.disposeTerminal(state.ptyId);
        state.terminal.dispose();
        const el = container.querySelector(`[data-terminal-id="${id}"]`);
        if (el) el.remove();
        map.delete(id);
      }
    }

    setInitialized(true);
  }, [terminals, activeTerminalId]);

  useEffect(() => {
    if (!initialized) return;
    const container = containerRef.current;
    if (!container) return;

    const map = terminalsMapRef.current;
    for (const [, state] of map) {
      const el = container.querySelector(
        `[data-terminal-id="${state.instance.id}"]`,
      ) as HTMLElement;
      if (el) {
        if (state.instance.id === activeTerminalId) {
          el.style.display = 'block';
          state.fitAddon.fit();
          api.resizeTerminal(state.ptyId, state.terminal.cols, state.terminal.rows);
          state.terminal.focus();
        } else {
          el.style.display = 'none';
        }
      }
    }
  }, [activeTerminalId, initialized]);

  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [handleResize]);

  useEffect(() => {
    const active = activeTerminalId ? terminalsMapRef.current.get(activeTerminalId) : null;
    if (active) {
      active.fitAddon.fit();
      api.resizeTerminal(active.ptyId, active.terminal.cols, active.terminal.rows);
    }
  }, [height, activeTerminalId]);

  useEffect(() => {
    return () => {
      const map = terminalsMapRef.current;
      for (const [, state] of map) {
        state.disposableData();
        state.disposableExit();
        api.disposeTerminal(state.ptyId);
        state.terminal.dispose();
      }
      map.clear();
    };
  }, []);

  const handleCloseTerminal = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const state = terminalsMapRef.current.get(id);
    if (state) {
      state.disposableData();
      state.disposableExit();
      api.disposeTerminal(state.ptyId);
      state.terminal.dispose();
      const el = containerRef.current?.querySelector(`[data-terminal-id="${id}"]`);
      if (el) el.remove();
      terminalsMapRef.current.delete(id);
    }
    onCloseTerminal(id);
  };

  return (
    <div
      className={`terminal-panel${maximized ? ' terminal-maximized' : ''}`}
      style={!maximized && height ? { height } : undefined}
    >
      <div className="terminal-header">
        <div className="terminal-tabs">
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`terminal-tab${t.id === activeTerminalId ? ' active' : ''}`}
              onClick={() => onSelectTerminal(t.id)}
            >
              <Codicon name="terminal" size={14} />
              <span className="terminal-tab-name">{t.name}</span>
              <button
                className="terminal-tab-close"
                onClick={(e) => handleCloseTerminal(e, t.id)}
                title="Close terminal"
              >
                <Codicon name="close" size={12} />
              </button>
            </div>
          ))}
          <button className="terminal-tab-add" onClick={onAddTerminal} title="New terminal">
            <Codicon name="add" size={14} />
          </button>
        </div>
        <div className="terminal-header-actions">
          {onMaximize && (
            <button
              type="button"
              className="icon-btn"
              title={maximized ? 'Restore' : 'Maximize'}
              onClick={onMaximize}
            >
              <Codicon name={maximized ? 'chrome-restore' : 'chrome-maximize'} size={14} />
            </button>
          )}
          <button type="button" className="icon-btn" title="Close panel" onClick={onClose}>
            <Codicon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </div>
  );
}
