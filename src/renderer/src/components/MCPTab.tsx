import { useEffect, useState } from 'react';
import { api } from '../api';
import { Codicon } from './Codicon';
import type { MCPServer, MCPType } from '../../../shared/types';

function makeEmptyServer(): MCPServer {
  return {
    command: '',
    env: [],
    args: [],
    type: 'stdio',
    url: '',
    headers: {},
    enabled: true,
  };
}

const AVATAR_COLORS = [
  '#5e6ad2',
  '#2ea043',
  '#bf3989',
  '#d29922',
  '#8957e5',
  '#3fb950',
  '#f78166',
  '#58a6ff',
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function parseEnvPairs(envs: string[]): [string, string][] {
  return envs.map((e) => {
    const idx = e.indexOf('=');
    return idx === -1 ? [e, ''] : [e.slice(0, idx), e.slice(idx + 1)];
  });
}

function envPairsToStrings(pairs: [string, string][]): string[] {
  return pairs.filter(([k]) => k.trim() !== '').map(([k, v]) => `${k}=${v}`);
}

export function MCPTab() {
  const [servers, setServers] = useState<Record<string, MCPServer>>({});
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    name: string;
    success: boolean;
    message: string;
  } | null>(null);
  const [pendingNew, setPendingNew] = useState<{ name: string; server: MCPServer } | null>(null);

  useEffect(() => {
    api.getMCPServers().then(({ servers }) => {
      setServers(servers);
      const names = Object.keys(servers);
      setSelectedName(names[0] ?? null);
    });
  }, []);

  const isPending = (name: string) => pendingNew !== null && pendingNew.name === name;

  function getServer(name: string): MCPServer | undefined {
    if (pendingNew && pendingNew.name === name) return pendingNew.server;
    return servers[name];
  }

  const selectedServer = selectedName ? getServer(selectedName) : null;
  const serverNames = Object.keys(servers);
  const allNames = pendingNew ? [...serverNames, pendingNew.name] : serverNames;

  function addServer() {
    let baseName = 'New Server';
    let name = baseName;
    let counter = 1;
    while (servers[name] || (pendingNew && pendingNew.name === name)) {
      name = `${baseName} ${counter++}`;
    }
    setPendingNew({ name, server: makeEmptyServer() });
    setSelectedName(name);
  }

  function cancelPending() {
    if (pendingNew && selectedName === pendingNew.name) {
      setSelectedName(serverNames[0] ?? null);
    }
    setPendingNew(null);
  }

  function deleteServer(name: string) {
    if (isPending(name)) {
      cancelPending();
      return;
    }
    const next = { ...servers };
    delete next[name];
    setServers(next);
    if (selectedName === name) {
      setSelectedName(Object.keys(next)[0] ?? null);
    }
  }

  function renameServer(oldName: string, newName: string) {
    if (!newName.trim() || oldName === newName) return;
    if (servers[newName] || (pendingNew && pendingNew.name === newName && oldName !== newName))
      return;

    if (isPending(oldName)) {
      setPendingNew({ name: newName, server: pendingNew!.server });
      setSelectedName(newName);
    } else {
      const next: Record<string, MCPServer> = {};
      for (const [n, config] of Object.entries(servers)) {
        if (n === oldName) {
          next[newName] = config;
        } else {
          next[n] = config;
        }
      }
      setServers(next);
      setSelectedName(newName);
    }
  }

  function updateServer(name: string, patch: Partial<MCPServer>) {
    if (isPending(name)) {
      setPendingNew({ name, server: { ...pendingNew!.server, ...patch } });
    } else {
      setServers({ ...servers, [name]: { ...servers[name], ...patch } });
    }
  }

  function toggleServer(name: string) {
    const server = getServer(name);
    if (!server) return;
    updateServer(name, { enabled: server.enabled === false ? true : false });
  }

  function mergePending(): Record<string, MCPServer> {
    if (!pendingNew) return servers;
    return { ...servers, [pendingNew.name]: pendingNew.server };
  }

  async function handleSave() {
    setSaving(true);
    setTestResult(null);
    try {
      const toSave = mergePending();
      await api.saveMCPServers(toSave);
      setServers(toSave);
      setPendingNew(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleTestServer(name: string) {
    setTestResult(null);
    try {
      const toSave = mergePending();
      await api.saveMCPServers({ ...toSave, [name]: toSave[name] });
      setServers(toSave);
      setPendingNew(null);
      setTestResult({ name, success: true, message: 'Server connected successfully' });
    } catch (error) {
      setTestResult({
        name,
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <div className="mcp-tab">
      <div className="mcp-sidebar">
        <div className="mcp-sidebar-header">
          <span className="mcp-sidebar-title">MCP Servers</span>
        </div>
        <div className="mcp-server-list">
          {allNames.length === 0 && <div className="mcp-empty">No MCP servers configured</div>}
          {allNames.map((name) => {
            const server = getServer(name);
            if (!server) return null;
            const enabled = server.enabled !== false;
            return (
              <div
                key={name}
                className={`mcp-server-item${name === selectedName ? ' active' : ''}${isPending(name) ? ' pending' : ''}`}
                onClick={() => setSelectedName(name)}
              >
                <div className="mcp-server-avatar" style={{ background: avatarColor(name) }}>
                  {name.charAt(0).toUpperCase()}
                </div>
                <div className="mcp-server-info">
                  <span className="mcp-server-name">{name}</span>
                  {enabled && !isPending(name) && (
                    <span className="mcp-server-status">
                      <span className="mcp-status-dot" />
                    </span>
                  )}
                  {isPending(name) && <span className="mcp-pending-badge">new</span>}
                </div>
                <button
                  type="button"
                  className={`mcp-toggle${enabled ? ' on' : ''}`}
                  title={enabled ? 'Disable server' : 'Enable server'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleServer(name);
                  }}
                >
                  <span className="mcp-toggle-thumb" />
                </button>
              </div>
            );
          })}
          <button type="button" className="mcp-add-server" onClick={addServer}>
            <div className="mcp-add-server-icon">
              <Codicon name="add" size={16} />
            </div>
            <div className="mcp-add-server-text">
              <span className="mcp-add-server-title">New MCP Server</span>
              <span className="mcp-add-server-desc">Add a Custom MCP Server</span>
            </div>
          </button>
        </div>
      </div>

      <div className="mcp-content">
        {!selectedServer ? (
          <div className="mcp-empty-detail">
            {allNames.length === 0
              ? 'Add an MCP server to get started.'
              : 'Select a server from the sidebar.'}
          </div>
        ) : (
          <>
            <div className="mcp-form">
              <label className="mcp-field">
                <span className="mcp-field-label">Server Name</span>
                <input
                  className="pc-input"
                  value={selectedName ?? ''}
                  onChange={(e) => renameServer(selectedName!, e.target.value)}
                  placeholder="New Server"
                />
              </label>

              <label className="mcp-field">
                <span className="mcp-field-label">Type</span>
                <select
                  className="pc-input"
                  value={selectedServer.type}
                  onChange={(e) => updateServer(selectedName!, { type: e.target.value as MCPType })}
                >
                  <option value="stdio">Stdio</option>
                  <option value="sse">SSE</option>
                </select>
              </label>

              {selectedServer.type === 'stdio' && (
                <>
                  <label className="mcp-field">
                    <span className="mcp-field-label">Command</span>
                    <input
                      className="pc-input"
                      value={selectedServer.command}
                      onChange={(e) => updateServer(selectedName!, { command: e.target.value })}
                      placeholder="npx"
                    />
                  </label>

                  <div className="mcp-section">
                    <div className="mcp-section-header">
                      <span className="mcp-field-label">Arguments</span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          updateServer(selectedName!, { args: [...selectedServer.args, ''] })
                        }
                      >
                        <Codicon name="add" size={12} /> Add argument
                      </button>
                    </div>
                    <div className="mcp-section-divider" />
                    {selectedServer.args.length > 0 && (
                      <div className="mcp-section-list">
                        {selectedServer.args.map((arg, index) => (
                          <div className="mcp-key-row" key={index}>
                            <input
                              className="pc-input"
                              placeholder="Argument"
                              value={arg}
                              onChange={(e) => {
                                const args = [...selectedServer.args];
                                args[index] = e.target.value;
                                updateServer(selectedName!, { args });
                              }}
                            />
                            <button
                              type="button"
                              className="icon-btn mcp-remove-btn"
                              title="Remove argument"
                              onClick={() => {
                                const args = selectedServer.args.filter((_, i) => i !== index);
                                updateServer(selectedName!, { args });
                              }}
                            >
                              <Codicon name="close" size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mcp-section">
                    <div className="mcp-section-header">
                      <span className="mcp-field-label">Environment Variables</span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const pairs = parseEnvPairs(selectedServer.env);
                          updateServer(selectedName!, {
                            env: envPairsToStrings([...pairs, ['', '']]),
                          });
                        }}
                      >
                        <Codicon name="add" size={12} /> Add env var
                      </button>
                    </div>
                    <div className="mcp-section-divider" />
                    {selectedServer.env.length > 0 && (
                      <div className="mcp-section-list">
                        {parseEnvPairs(selectedServer.env).map(([key, value], index, entries) => (
                          <div className="mcp-key-row" key={index}>
                            <input
                              className="pc-input"
                              placeholder="Variable name"
                              value={key}
                              onChange={(e) => {
                                const next: [string, string][] = entries.map(([k, v], i) =>
                                  i === index ? [e.target.value, v] : [k, v],
                                );
                                updateServer(selectedName!, { env: envPairsToStrings(next) });
                              }}
                            />
                            <input
                              className="pc-input"
                              placeholder="Value"
                              value={value}
                              onChange={(e) => {
                                const next: [string, string][] = entries.map(([k, v], i) =>
                                  i === index ? [k, e.target.value] : [k, v],
                                );
                                updateServer(selectedName!, { env: envPairsToStrings(next) });
                              }}
                            />
                            <button
                              type="button"
                              className="icon-btn mcp-remove-btn"
                              title="Remove"
                              onClick={() => {
                                const next = entries.filter((_, i) => i !== index);
                                updateServer(selectedName!, { env: envPairsToStrings(next) });
                              }}
                            >
                              <Codicon name="close" size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {selectedServer.type === 'sse' && (
                <>
                  <label className="mcp-field">
                    <span className="mcp-field-label">URL</span>
                    <input
                      className="pc-input"
                      value={selectedServer.url}
                      onChange={(e) => updateServer(selectedName!, { url: e.target.value })}
                      placeholder="https://..."
                    />
                  </label>

                  <div className="mcp-section">
                    <div className="mcp-section-header">
                      <span className="mcp-field-label">Headers</span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          const headers: [string, string][] = [
                            ...Object.entries(selectedServer.headers),
                            ['', ''],
                          ];
                          updateServer(selectedName!, {
                            headers: Object.fromEntries(headers.filter(([k]) => k)),
                          });
                        }}
                      >
                        <Codicon name="add" size={12} /> Add header
                      </button>
                    </div>
                    <div className="mcp-section-divider" />
                    {Object.entries(selectedServer.headers).length > 0 && (
                      <div className="mcp-section-list">
                        {Object.entries(selectedServer.headers).map(
                          ([hKey, hValue], index, entries) => (
                            <div className="mcp-key-row" key={index}>
                              <input
                                className="pc-input"
                                placeholder="Header name"
                                value={hKey}
                                onChange={(e) => {
                                  const next: [string, string][] = entries.map(([k, v], i) =>
                                    i === index ? [e.target.value, v] : [k, v],
                                  );
                                  updateServer(selectedName!, {
                                    headers: Object.fromEntries(next.filter(([k]) => k)),
                                  });
                                }}
                              />
                              <input
                                className="pc-input"
                                placeholder="Header value"
                                value={hValue}
                                onChange={(e) => {
                                  const next: [string, string][] = entries.map(([k, v], i) =>
                                    i === index ? [k, e.target.value] : [k, v],
                                  );
                                  updateServer(selectedName!, {
                                    headers: Object.fromEntries(next.filter(([k]) => k)),
                                  });
                                }}
                              />
                              <button
                                type="button"
                                className="icon-btn mcp-remove-btn"
                                title="Remove header"
                                onClick={() => {
                                  const next = entries.filter((_, i) => i !== index);
                                  updateServer(selectedName!, {
                                    headers: Object.fromEntries(next.filter(([k]) => k)),
                                  });
                                }}
                              >
                                <Codicon name="close" size={14} />
                              </button>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {testResult && testResult.name === selectedName && (
              <div className={`mcp-test-result ${testResult.success ? 'success' : 'error'}`}>
                <Codicon name={testResult.success ? 'pass' : 'error'} size={14} />
                {testResult.message}
              </div>
            )}

            <div className="pc-footer">
              {pendingNew && selectedName === pendingNew.name && (
                <button type="button" className="btn btn-secondary" onClick={cancelPending}>
                  Cancel
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => handleTestServer(selectedName!)}
              >
                Test & Save
              </button>
              <button type="button" className="btn" disabled={saving} onClick={handleSave}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
