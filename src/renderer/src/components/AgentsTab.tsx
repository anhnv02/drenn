import { useEffect, useState } from 'react';
import { api } from '../api';
import { Codicon } from './Codicon';
import { useConfirm } from '../shared/confirm';
import type { AgentInfo } from '../../../shared/types';

export function AgentsTab({ sessionId }: { sessionId: string | null }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [description, setDescription] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAgents(sessionId ?? undefined).then(({ agents }) => setAgents(agents));
  }, [sessionId]);

  async function handleGenerate() {
    const trimmed = description.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const agent = await api.generateAgent(trimmed);
      setAgents((prev) => [agent, ...prev.filter((a) => a.name !== agent.name)]);
      setDescription('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleUpdate(name: string, patch: Partial<AgentInfo>) {
    const updated = await api.updateAgent(name, patch, sessionId ?? undefined);
    setAgents((prev) => prev.map((a) => (a.name === name ? updated : a)));
  }

  async function handleDelete(name: string) {
    await api.deleteAgent(name, sessionId ?? undefined);
    setAgents((prev) => prev.filter((a) => a.name !== name));
  }

  const primary = agents.filter((a) => a.mode !== 'subagent');
  const subagents = agents.filter((a) => a.mode === 'subagent');

  return (
    <div className="pr-body ag-body">
      <div className="ag-generate">
        <span className="pc-field-label">Create a new sub-agent</span>
        <textarea
          className="pc-input ag-textarea"
          placeholder="Describe what this agent should do, e.g. “Writes and runs unit tests for changed files, read-only elsewhere.”"
          value={description}
          rows={3}
          disabled={generating}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleGenerate();
          }}
        />
        {error && <span className="field-error">{error}</span>}
        <div className="ag-generate-actions">
          <button
            type="button"
            className="btn"
            disabled={generating || !description.trim()}
            onClick={handleGenerate}
          >
            {generating ? 'Generating…' : 'Generate agent'}
          </button>
        </div>
      </div>

      {subagents.length > 0 && (
        <div className="ag-section">
          <div className="ag-section-title">Sub-agents</div>
          {subagents.map((a) => (
            <AgentCard key={a.name} agent={a} onUpdate={handleUpdate} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {primary.length > 0 && (
        <div className="ag-section">
          <div className="ag-section-title">Primary agents</div>
          {primary.map((a) => (
            <AgentCard key={a.name} agent={a} onUpdate={handleUpdate} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  onUpdate,
  onDelete,
}: {
  agent: AgentInfo;
  onUpdate: (name: string, patch: Partial<AgentInfo>) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState(agent.description);
  const [prompt, setPrompt] = useState(agent.prompt ?? '');
  const [temperature, setTemperature] = useState(agent.temperature?.toString() ?? '');
  const [topP, setTopP] = useState(agent.topP?.toString() ?? '');
  const [steps, setSteps] = useState(agent.steps?.toString() ?? '');
  const [disabledTools, setDisabledTools] = useState((agent.disabledTools ?? []).join(', '));
  const { confirm } = useConfirm();

  function startEdit() {
    setDescription(agent.description);
    setPrompt(agent.prompt ?? '');
    setTemperature(agent.temperature?.toString() ?? '');
    setTopP(agent.topP?.toString() ?? '');
    setSteps(agent.steps?.toString() ?? '');
    setDisabledTools((agent.disabledTools ?? []).join(', '));
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onUpdate(agent.name, {
        description: description.trim(),
        prompt: prompt.trim() || undefined,
        temperature: temperature.trim() ? Number(temperature) : undefined,
        topP: topP.trim() ? Number(topP) : undefined,
        steps: steps.trim() ? Number(steps) : undefined,
        disabledTools: disabledTools
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete agent?',
      message: `Delete agent "${agent.name}"? This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await onDelete(agent.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (editing) {
    return (
      <div className="ag-card ag-card-editing">
        <div className="ag-card-head">
          <span className="ag-card-name">{agent.name}</span>
          <span className="ag-tag">{agent.mode}</span>
        </div>
        {error && <span className="field-error">{error}</span>}
        <div className="pc-field">
          <span className="pc-field-label">Description</span>
          <textarea
            className="pc-input ag-textarea"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="pc-field">
          <span className="pc-field-label">System prompt</span>
          <textarea
            className="pc-input ag-textarea"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="ag-edit-row">
          <div className="pc-field">
            <span className="pc-field-label">Temperature</span>
            <input
              className="pc-input"
              type="number"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(e.target.value)}
            />
          </div>
          <div className="pc-field">
            <span className="pc-field-label">Top P</span>
            <input
              className="pc-input"
              type="number"
              step="0.1"
              value={topP}
              onChange={(e) => setTopP(e.target.value)}
            />
          </div>
          <div className="pc-field">
            <span className="pc-field-label">Max steps</span>
            <input
              className="pc-input"
              type="number"
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
            />
          </div>
        </div>
        <div className="pc-field">
          <span className="pc-field-label">Disabled tools (comma-separated)</span>
          <input
            className="pc-input"
            value={disabledTools}
            onChange={(e) => setDisabledTools(e.target.value)}
            placeholder="bash, write"
          />
        </div>
        <div className="ag-edit-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setEditing(false)}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleSave}
            disabled={saving || !description.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ag-card">
      <div className="ag-card-head">
        <span className="ag-card-name">{agent.name}</span>
        {agent.color && (
          <span
            className="ag-color-dot"
            style={{ background: agent.color }}
            title={`Color: ${agent.color}`}
          />
        )}
        <span className="ag-tag">{agent.mode}</span>
        {agent.native ? (
          <span className="ag-tag ag-tag-native">built-in</span>
        ) : agent.scope === 'project' ? (
          <span className="ag-tag ag-tag-native" title={agent.origin}>
            project
          </span>
        ) : (
          <span className="ag-tag ag-tag-custom">generated</span>
        )}
        {agent.temperature !== undefined && (
          <span className="ag-temp" title="Temperature">
            temp {agent.temperature}
          </span>
        )}
        {agent.topP !== undefined && (
          <span className="ag-temp" title="Top P">
            topP {agent.topP}
          </span>
        )}
        {agent.steps !== undefined && (
          <span className="ag-temp" title="Max steps">
            steps {agent.steps}
          </span>
        )}
        {!agent.native && agent.scope !== 'project' && (
          <div className="ag-card-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={startEdit}
              title="Edit agent"
              aria-label="Edit agent"
            >
              Edit
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={handleDelete}
              title="Delete agent"
              aria-label="Delete agent"
            >
              <Codicon name="trash" size={13} />
            </button>
          </div>
        )}
      </div>
      {error && <span className="field-error">{error}</span>}
      <div className="ag-card-desc">{agent.description}</div>
      {agent.disabledTools && agent.disabledTools.length > 0 && (
        <div className="ag-tools">
          <span className="ag-tools-label">Disabled:</span>
          {agent.disabledTools.map((t) => (
            <span className="ag-tool-chip" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      {agent.prompt && <div className="ag-card-prompt">{agent.prompt}</div>}
    </div>
  );
}
