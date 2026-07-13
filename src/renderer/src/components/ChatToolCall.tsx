import { useState } from 'react';
import './ChatToolCall.css';

export interface ToolCallDisplay {
  id: string;
  name: string;
  input: string;
  result?: {
    content: string;
    isError: boolean;
    metadata?: Record<string, any>;
  };
}

interface SubAgentToolCall {
  tool: string;
  input: unknown;
  output?: string;
}

function parseInput(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p.replace(/^\//, '');
  return parts.slice(-3).join('/');
}

function primaryArg(name: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'view':
    case 'edit':
    case 'write':
      return shortenPath(str(args.file_path));
    case 'ls':
      return shortenPath(str(args.path)) || '.';
    case 'glob':
    case 'grep':
      return str(args.pattern);
    case 'bash':
      return str(args.command);
    case 'fetch':
      return str(args.url);
    case 'task':
      return str(args.description);
    default: {
      const first = Object.values(args).find((v) => typeof v === 'string');
      return typeof first === 'string' ? first : '';
    }
  }
}

function countLines(s: string): number {
  const t = s.replace(/\n+$/, '');
  return t ? t.split('\n').length : 0;
}

function resultSummary(name: string, content: string): string {
  const lines = countLines(content);
  switch (name) {
    case 'view':
      return `Read ${lines} line${lines === 1 ? '' : 's'}`;
    case 'glob':
    case 'grep':
      return `${lines} match${lines === 1 ? '' : 'es'}`;
    case 'ls':
      return `${lines} item${lines === 1 ? '' : 's'}`;
    case 'write':
      return 'Wrote file';
    case 'edit':
      return 'Updated file';
    default: {
      const first = content.replace(/\n+$/, '').split('\n')[0] ?? '';
      if (lines <= 1) return first.slice(0, 120);
      return `${first.slice(0, 100)} (+${lines - 1} lines)`;
    }
  }
}

function SubAgentSteps({ toolCalls }: { toolCalls: SubAgentToolCall[] }) {
  return (
    <div className="tool-call-substeps">
      {toolCalls.map((t, i) => {
        const args =
          typeof t.input === 'string'
            ? parseInput(t.input)
            : ((t.input as Record<string, unknown>) ?? {});
        const arg = primaryArg(t.tool, args);
        return (
          <div key={i} className="tool-call-substep">
            <span className="tool-call-branch">⎿</span>
            <span className="tool-call-name">{t.tool}</span>
            {arg && (
              <span className="tool-call-arg" title={arg}>
                ({arg})
              </span>
            )}
            {t.output && (
              <span className="tool-call-substep-summary">{resultSummary(t.tool, t.output)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ChatToolCall({ tc }: { tc: ToolCallDisplay }) {
  const [expanded, setExpanded] = useState(false);
  const args = parseInput(tc.input);
  const arg = primaryArg(tc.name, args);
  const result = tc.result;
  const running = !result;

  const isTask = tc.name === 'task';
  const subSteps: SubAgentToolCall[] | undefined =
    isTask && Array.isArray(result?.metadata?.toolCalls) ? result!.metadata!.toolCalls : undefined;

  const content = result?.content ?? '';
  const summary = result
    ? result.isError
      ? content.replace(/\n+$/, '').split('\n')[0].slice(0, 160) || 'Error'
      : isTask
        ? `${result.metadata?.subagent ?? 'Sub-agent'} finished${subSteps?.length ? ` · ${subSteps.length} step${subSteps.length === 1 ? '' : 's'}` : ''}`
        : resultSummary(tc.name, content)
    : isTask
      ? `${typeof args.subagent_type === 'string' ? args.subagent_type : 'Sub-agent'} working…`
      : '';
  const expandable = !!result && (content.trim().length > 0 || !!subSteps?.length);

  return (
    <div className="tool-call">
      <div className="tool-call-head">
        <span
          className={`tool-call-dot${running ? ' running' : ''}${result?.isError ? ' error' : ''}`}
        >
          ●
        </span>
        <span className="tool-call-name">{tc.name}</span>
        {arg && (
          <span className="tool-call-arg" title={arg}>
            ({arg})
          </span>
        )}
      </div>

      <div
        className={`tool-call-result${expandable ? ' clickable' : ''}${result?.isError ? ' error' : ''}`}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setExpanded((v) => !v);
                }
              }
            : undefined
        }
      >
        <span className="tool-call-branch">⎿</span>
        {running ? (
          <span className="tool-call-summary running">{summary || 'Running…'}</span>
        ) : (
          <span className="tool-call-summary">{summary || 'Done'}</span>
        )}
        {expandable && <span className="tool-call-toggle">{expanded ? 'hide' : 'show'}</span>}
      </div>

      {expanded && expandable && (
        <div className={`tool-call-body${result?.isError ? ' error' : ''}`}>
          {subSteps && subSteps.length > 0 && <SubAgentSteps toolCalls={subSteps} />}
          {content.trim() && <pre className="tool-call-body-text">{content}</pre>}
        </div>
      )}
    </div>
  );
}
