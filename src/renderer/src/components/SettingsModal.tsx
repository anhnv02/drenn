import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Provider, ProviderModel } from '../../../shared/types';
import { Codicon } from './Codicon';
import { PermissionsTab } from './PermissionsTab';
import { AgentsTab } from './AgentsTab';
import { MCPTab } from './MCPTab';
import './SettingsModal.css';

const XIAOMI_BUILTIN_ID = '__xiaomi__';
const NVIDIA_PROVIDER_ID = '__nvidia__';
const NVIDIA_MODEL_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

export type SettingsTab = 'providers' | 'permissions' | 'agents' | 'mcp';

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
  sessionId?: string | null;
}

function makeNvidiaProvider(): Provider {
  return {
    id: NVIDIA_PROVIDER_ID,
    name: 'Nvidia NIM',
    vendor: 'nvidia',
    apiKey: '',
    apiType: 'chat-completions',
    models: [],
  };
}

function makeNvidiaModel(): ProviderModel {
  return {
    id: '',
    name: '',
    url: NVIDIA_MODEL_URL,
    toolCalling: true,
    streaming: true,
    maxTokens: 8192,
    requestHeaders: {},
    temperature: 1.0,
    topP: 0.95,
  };
}

function modelErrors(m: ProviderModel, siblings: ProviderModel[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!m.id.trim()) errors.id = 'ID is required';
  else if (siblings.filter((s) => s.id === m.id).length > 1) errors.id = 'Duplicate model ID';
  if (!m.name.trim()) errors.name = 'Name is required';
  if (!Number.isFinite(m.maxTokens) || m.maxTokens <= 0) {
    errors.maxTokens = 'Must be a positive number';
  }
  if (m.temperature !== undefined && (m.temperature < 0 || m.temperature > 2)) {
    errors.temperature = 'Must be between 0 and 2';
  }
  if (m.topP !== undefined && (m.topP < 0 || m.topP > 1)) {
    errors.topP = 'Must be between 0 and 1';
  }
  return errors;
}

function nvidiaApiKeyError(p: Provider): string | null {
  return p.models.length > 0 && !p.apiKey.trim() ? 'API key is required' : null;
}

function hasAnyErrors(p: Provider): boolean {
  return (
    nvidiaApiKeyError(p) !== null ||
    p.models.some((m) => Object.keys(modelErrors(m, p.models)).length > 0)
  );
}

export function SettingsModal({ onClose, initialTab = 'providers', sessionId = null }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [selectedId, setSelectedId] = useState<string>(XIAOMI_BUILTIN_ID);
  const [nvidia, setNvidia] = useState<Provider>(makeNvidiaProvider());
  const [expandedModel, setExpandedModel] = useState<number | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [xiaomiApiKey, setXiaomiApiKey] = useState('');
  const [showXiaomiApiKey, setShowXiaomiApiKey] = useState(false);
  const [xiaomiModels, setXiaomiModels] = useState<{ id: string; name: string }[]>([]);
  const [xiaomiModelsLoading, setXiaomiModelsLoading] = useState(false);

  useEffect(() => {
    api.getProviders().then(({ providers }) => {
      const existing = providers.find((p) => p.id === NVIDIA_PROVIDER_ID);
      if (existing) {
        setNvidia(existing);
        return;
      }
      const legacy = providers.find(
        (p) =>
          p.name.toLowerCase().includes('nvidia') || p.models.some((m) => m.url.includes('nvidia')),
      );
      if (legacy) {
        setNvidia({
          ...makeNvidiaProvider(),
          apiKey: legacy.apiKey,
          models: legacy.models.map((m) => ({ ...m, url: NVIDIA_MODEL_URL })),
        });
      }
    });
    api.getXiaomiApiKey().then((key) => {
      setXiaomiApiKey(key);
      if (key) {
        setXiaomiModelsLoading(true);
        api.fetchXiaomiModels().then(({ models }) => {
          setXiaomiModels(models);
          setXiaomiModelsLoading(false);
        });
      }
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function updateModelAt(index: number, patch: Partial<ProviderModel>) {
    setNvidia({
      ...nvidia,
      models: nvidia.models.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });
  }

  function deleteModelAt(index: number) {
    setNvidia({ ...nvidia, models: nvidia.models.filter((_, i) => i !== index) });
    if (expandedModel === null) return;
    if (expandedModel === index) setExpandedModel(null);
    else if (expandedModel > index) setExpandedModel(expandedModel - 1);
  }

  function addModel() {
    setNvidia({ ...nvidia, models: [makeNvidiaModel(), ...nvidia.models] });
    setExpandedModel(0);
  }

  function updateModelHeaders(index: number, entries: [string, string][]) {
    updateModelAt(index, { requestHeaders: Object.fromEntries(entries) });
  }

  async function handleSave() {
    if (hasAnyErrors(nvidia)) return;
    setSaving(true);
    try {
      const toSave: Provider = {
        ...nvidia,
        models: nvidia.models.map((m) => ({ ...m, url: NVIDIA_MODEL_URL })),
      };
      const [{ providers: saved }] = await Promise.all([
        api.saveProviders([toSave]),
        api.saveXiaomiApiKey(xiaomiApiKey),
      ]);
      setNvidia(saved.find((p) => p.id === NVIDIA_PROVIDER_ID) ?? toSave);
      window.dispatchEvent(new CustomEvent('settings:saved'));
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const saveDisabled = saving || hasAnyErrors(nvidia);
  const apiKeyError = nvidiaApiKeyError(nvidia);

  return (
    <div className="pc-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="pc-card" onClick={(e) => e.stopPropagation()}>
        <div className="pc-header">
          <span className="pc-title">Settings</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            <Codicon name="close" size={14} />
          </button>
        </div>

        <div className="sm-main">
          <div className="sm-nav">
            <button
              type="button"
              className={`sm-nav-item${tab === 'providers' ? ' active' : ''}`}
              onClick={() => setTab('providers')}
            >
              Providers
            </button>

            <button
              type="button"
              className={`sm-nav-item${tab === 'permissions' ? ' active' : ''}`}
              onClick={() => setTab('permissions')}
            >
              Permissions
            </button>

            <button
              type="button"
              className={`sm-nav-item${tab === 'agents' ? ' active' : ''}`}
              onClick={() => setTab('agents')}
            >
              Agents
            </button>

            <button
              type="button"
              className={`sm-nav-item${tab === 'mcp' ? ' active' : ''}`}
              onClick={() => setTab('mcp')}
            >
              MCP
            </button>
          </div>

          <div className="sm-content">
            {tab === 'permissions' ? (
              <div className="pc-body sm-body-scroll">
                <PermissionsTab />
              </div>
            ) : tab === 'agents' ? (
              <div className="pc-body sm-body-scroll">
                <AgentsTab sessionId={sessionId} />
              </div>
            ) : tab === 'mcp' ? (
              <MCPTab />
            ) : (
              <div className="pc-body">
                <div className="pv-sidebar">
                  <div className="pv-list">
                    <div
                      className={`pv-item${selectedId === XIAOMI_BUILTIN_ID ? ' active' : ''}`}
                      onClick={() => setSelectedId(XIAOMI_BUILTIN_ID)}
                    >
                      <div className="pv-item-text">
                        <span className="pv-item-name">Xiaomi MiMo</span>
                        <span className="pv-item-vendor">xiaomi</span>
                      </div>
                    </div>
                    <div
                      className={`pv-item${selectedId === NVIDIA_PROVIDER_ID ? ' active' : ''}`}
                      onClick={() => setSelectedId(NVIDIA_PROVIDER_ID)}
                    >
                      <div className="pv-item-text">
                        <span className="pv-item-name">Nvidia NIM</span>
                        <span className="pv-item-vendor">nvidia</span>
                      </div>
                    </div>
                  </div>
                </div>
                {selectedId === XIAOMI_BUILTIN_ID ? (
                  <div className="pc-detail">
                    <div className="pc-form-grid">
                      <label className="pc-field pc-field-wide">
                        <span className="pc-field-label">API Key</span>
                        <div className="pc-input-with-action">
                          <input
                            className="pc-input"
                            type={showXiaomiApiKey ? 'text' : 'password'}
                            value={xiaomiApiKey}
                            onChange={(e) => setXiaomiApiKey(e.target.value)}
                            placeholder="sk-..."
                          />
                          <button
                            type="button"
                            className="btn btn-secondary pc-input-action-btn"
                            onClick={() => setShowXiaomiApiKey((v) => !v)}
                          >
                            {showXiaomiApiKey ? 'Hide' : 'Show'}
                          </button>
                        </div>
                      </label>
                      <div className="pc-field pc-field-wide">
                        <div className="pc-field-label-row">
                          <span className="pc-field-label">Models</span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={async () => {
                              setXiaomiModelsLoading(true);
                              const { models } = await api.fetchXiaomiModels();
                              setXiaomiModels(models);
                              setXiaomiModelsLoading(false);
                            }}
                            disabled={xiaomiModelsLoading || !xiaomiApiKey}
                          >
                            {xiaomiModelsLoading ? (
                              <Codicon name="loading" size={12} className="spin-icon" />
                            ) : (
                              <Codicon name="refresh" size={12} />
                            )}
                            <span>{xiaomiModelsLoading ? 'Loading' : 'Refresh'}</span>
                          </button>
                        </div>
                        <div className="pc-builtin-models">
                          {xiaomiModels.length > 0 ? (
                            xiaomiModels.map((m) => (
                              <div key={m.id} className="pc-model-row">
                                <div className="pc-model-row-header pc-model-row-static">
                                  <span className="pc-model-row-name">{m.name || m.id}</span>
                                  <span className="pc-model-row-id">{m.id}</span>
                                </div>
                              </div>
                            ))
                          ) : (
                            <span className="pc-field-hint">
                              {xiaomiApiKey
                                ? 'Click Refresh to load models'
                                : 'Enter API key first'}
                            </span>
                          )}
                        </div>
                      </div>
                      <a
                        href="https://platform.xiaomimimo.com/#/console/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="sm-xiaomi-link"
                      >
                        Get API Key from Xiaomi MiMo Platform
                      </a>
                    </div>
                  </div>
                ) : (
                  <div className="pc-detail">
                    <div className="pc-form-grid">
                      <label className="pc-field pc-field-wide">
                        <span className="pc-field-label">API Key</span>
                        <div className="pc-input-with-action">
                          <input
                            className="pc-input"
                            type={showApiKey ? 'text' : 'password'}
                            value={nvidia.apiKey}
                            onChange={(e) => setNvidia({ ...nvidia, apiKey: e.target.value })}
                            placeholder="nvapi-..."
                          />
                          <button
                            type="button"
                            className="btn btn-secondary pc-input-action-btn"
                            onClick={() => setShowApiKey((v) => !v)}
                          >
                            {showApiKey ? 'Hide' : 'Show'}
                          </button>
                        </div>
                        {apiKeyError && <span className="field-error">{apiKeyError}</span>}
                      </label>
                    </div>

                    <div className="pc-models-section">
                      <div className="pc-models-header">
                        <span className="section-title">Models</span>
                        <button type="button" className="btn btn-secondary" onClick={addModel}>
                          <Codicon name="add" size={14} /> Add model
                        </button>
                      </div>

                      {nvidia.models.length === 0 && (
                        <div className="pc-empty-hint">No models yet.</div>
                      )}

                      {nvidia.models.map((m, index) => {
                        const open = expandedModel === index;
                        const mErrors = modelErrors(m, nvidia.models);
                        const headerEntries = Object.entries(m.requestHeaders);
                        return (
                          <div className="pc-model-row" key={index}>
                            <div
                              className="pc-model-row-header"
                              onClick={() => setExpandedModel(open ? null : index)}
                            >
                              <Codicon
                                name="chevron-right"
                                size={10}
                                className={`tree-chevron-icon${open ? ' open' : ''}`}
                              />
                              <span className="pc-model-row-name">{m.name || 'New model'}</span>
                              <span className="pc-model-row-id">{m.id}</span>
                              {Object.keys(mErrors).length > 0 && (
                                <span className="field-error pc-model-row-error">
                                  <Codicon name="warning" size={14} />
                                </span>
                              )}
                              <button
                                type="button"
                                className="icon-btn pc-model-row-delete"
                                title="Delete model"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteModelAt(index);
                                }}
                              >
                                <Codicon name="close" size={14} />
                              </button>
                            </div>
                            {open && (
                              <div className="pc-model-detail">
                                <div className="pc-form-grid">
                                  <label className="pc-field">
                                    <span className="pc-field-label">ID</span>
                                    <input
                                      className="pc-input"
                                      value={m.id}
                                      placeholder="e.g. deepseek-ai/deepseek-v4-pro"
                                      onChange={(e) => updateModelAt(index, { id: e.target.value })}
                                    />
                                    {mErrors.id && (
                                      <span className="field-error">{mErrors.id}</span>
                                    )}
                                  </label>
                                  <label className="pc-field">
                                    <span className="pc-field-label">Name</span>
                                    <input
                                      className="pc-input"
                                      value={m.name}
                                      onChange={(e) =>
                                        updateModelAt(index, { name: e.target.value })
                                      }
                                    />
                                    {mErrors.name && (
                                      <span className="field-error">{mErrors.name}</span>
                                    )}
                                  </label>
                                  <label className="pc-field">
                                    <span className="pc-field-label">Max tokens</span>
                                    <input
                                      className="pc-input"
                                      type="number"
                                      value={m.maxTokens}
                                      onChange={(e) =>
                                        updateModelAt(index, { maxTokens: Number(e.target.value) })
                                      }
                                    />
                                    {mErrors.maxTokens && (
                                      <span className="field-error">{mErrors.maxTokens}</span>
                                    )}
                                  </label>
                                  <label className="pc-field">
                                    <span className="pc-field-label">Temperature</span>
                                    <input
                                      className="pc-input"
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      max="2"
                                      value={m.temperature ?? 1.0}
                                      onChange={(e) =>
                                        updateModelAt(index, {
                                          temperature: Number(e.target.value),
                                        })
                                      }
                                    />
                                    {mErrors.temperature && (
                                      <span className="field-error">{mErrors.temperature}</span>
                                    )}
                                  </label>
                                  <label className="pc-field">
                                    <span className="pc-field-label">Top P</span>
                                    <input
                                      className="pc-input"
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      max="1"
                                      value={m.topP ?? 0.95}
                                      onChange={(e) =>
                                        updateModelAt(index, { topP: Number(e.target.value) })
                                      }
                                    />
                                    {mErrors.topP && (
                                      <span className="field-error">{mErrors.topP}</span>
                                    )}
                                  </label>
                                </div>

                                <div className="pc-checkbox-row">
                                  <label className="pc-checkbox">
                                    <input
                                      type="checkbox"
                                      checked={m.toolCalling}
                                      onChange={(e) =>
                                        updateModelAt(index, { toolCalling: e.target.checked })
                                      }
                                    />
                                    Tool calling
                                  </label>
                                  <label className="pc-checkbox">
                                    <input
                                      type="checkbox"
                                      checked={m.streaming}
                                      onChange={(e) =>
                                        updateModelAt(index, { streaming: e.target.checked })
                                      }
                                    />
                                    Streaming
                                  </label>
                                </div>

                                <div className="pc-headers-section">
                                  <div className="pc-headers-header">
                                    <span className="pc-field-label">Request headers</span>
                                    <button
                                      type="button"
                                      className="btn btn-secondary"
                                      onClick={() =>
                                        updateModelHeaders(index, [...headerEntries, ['', '']])
                                      }
                                    >
                                      <Codicon name="add" size={14} /> Add header
                                    </button>
                                  </div>
                                  {headerEntries.map(([hKey, hValue], hIndex) => (
                                    <div className="pc-header-row" key={hIndex}>
                                      <input
                                        className="pc-input"
                                        placeholder="Header name"
                                        value={hKey}
                                        onChange={(e) => {
                                          const next = [...headerEntries];
                                          next[hIndex] = [e.target.value, hValue];
                                          updateModelHeaders(index, next);
                                        }}
                                      />
                                      <input
                                        className="pc-input"
                                        placeholder="Header value"
                                        value={hValue}
                                        onChange={(e) => {
                                          const next = [...headerEntries];
                                          next[hIndex] = [hKey, e.target.value];
                                          updateModelHeaders(index, next);
                                        }}
                                      />
                                      <button
                                        type="button"
                                        className="icon-btn"
                                        title="Remove header"
                                        onClick={() => {
                                          const next = headerEntries.filter((_, i) => i !== hIndex);
                                          updateModelHeaders(index, next);
                                        }}
                                      >
                                        <Codicon name="close" size={14} />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <a
                      href="https://build.nvidia.com/settings/api-keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="sm-xiaomi-link"
                    >
                      Get API Key from NVIDIA Build Platform
                    </a>
                  </div>
                )}
              </div>
            )}

            {tab === 'providers' && (
              <div className="pc-footer">
                <button type="button" className="btn btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="btn" disabled={saveDisabled} onClick={handleSave}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
