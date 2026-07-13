import { describe, it, expect } from 'vitest';
import { TextToolCallFilter } from '../../../main/agent/textToolCall';

const TC_OPEN = String.fromCharCode(60) + 'tool_call';
const TC_CLOSE = String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62);
const FN_OPEN = String.fromCharCode(60) + 'function=';
const PM_OPEN = String.fromCharCode(60) + 'parameter=';
const PM_CLOSE = String.fromCharCode(60) + '/parameter' + String.fromCharCode(62);

function tc(functionName: string, params: Record<string, string>) {
  let block = TC_OPEN + String.fromCharCode(62) + FN_OPEN + functionName + String.fromCharCode(62);
  for (const [k, v] of Object.entries(params)) {
    block += PM_OPEN + k + String.fromCharCode(62) + v + PM_CLOSE;
  }
  block += TC_CLOSE;
  return block;
}

describe('TextToolCallFilter', () => {
  it('passes plain text through', () => {
    const filter = new TextToolCallFilter();
    const result = filter.push('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.calls).toEqual([]);
  });

  it('extracts a complete tool call', () => {
    const filter = new TextToolCallFilter();
    const block = tc('ls', { path: '/src' });
    const result = filter.push(block);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('ls');
    const input = JSON.parse(result.calls[0].input);
    expect(input.path).toBe('/src');
  });

  it('holds back partial open tag', () => {
    const filter = new TextToolCallFilter();
    const result = filter.push('Hello <tool_ca');
    expect(result.text).toBe('Hello ');
    expect(result.calls).toEqual([]);
  });

  it('completes partial tag on next push', () => {
    const filter = new TextToolCallFilter();
    filter.push('Hello <tool_ca');
    const block =
      'll' +
      String.fromCharCode(62) +
      FN_OPEN +
      'ls' +
      String.fromCharCode(62) +
      PM_OPEN +
      'path' +
      String.fromCharCode(62) +
      '/src' +
      PM_CLOSE +
      TC_CLOSE;
    const result = filter.push(block);
    expect(result.text).toBe('');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('ls');
  });

  it('extracts multiple tool calls', () => {
    const filter = new TextToolCallFilter();
    const block = 'Text1  ' + tc('ls', { path: '/a' }) + ' Text2  ' + tc('cat', { path: '/b' });
    const result = filter.push(block);
    expect(result.text).toBe('Text1   Text2  ');
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].name).toBe('ls');
    expect(result.calls[1].name).toBe('cat');
  });

  it('handles tool call with multiple parameters', () => {
    const filter = new TextToolCallFilter();
    const block = tc('edit', { file_path: '/a.ts', old_string: 'old', new_string: 'new' });
    const result = filter.push(block);
    expect(result.calls).toHaveLength(1);
    const input = JSON.parse(result.calls[0].input);
    expect(input.file_path).toBe('/a.ts');
    expect(input.old_string).toBe('old');
    expect(input.new_string).toBe('new');
  });

  it('coerces numeric values', () => {
    const filter = new TextToolCallFilter();
    const block = tc('test', { count: '42', rate: '3.14' });
    const result = filter.push(block);
    const input = JSON.parse(result.calls[0].input);
    expect(input.count).toBe(42);
    expect(input.rate).toBe(3.14);
  });

  it('coerces boolean values', () => {
    const filter = new TextToolCallFilter();
    const block = tc('test', { flag: 'true', other: 'false' });
    const result = filter.push(block);
    const input = JSON.parse(result.calls[0].input);
    expect(input.flag).toBe(true);
    expect(input.other).toBe(false);
  });

  it('flush returns text already emitted by push plus buffer remainder', () => {
    const filter = new TextToolCallFilter();
    const pushed = filter.push('Hello ');
    expect(pushed.text).toBe('Hello ');
    const result = filter.flush();
    expect(result.text).toBe('');
    expect(result.calls).toEqual([]);
  });

  it('flush parses unterminated tool call', () => {
    const filter = new TextToolCallFilter();
    const partial =
      TC_OPEN +
      String.fromCharCode(62) +
      FN_OPEN +
      'ls' +
      String.fromCharCode(62) +
      PM_OPEN +
      'path' +
      String.fromCharCode(62) +
      '/src' +
      PM_CLOSE;
    filter.push(partial);
    const result = filter.flush();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('ls');
  });

  it('handles stream split across multiple deltas', () => {
    const filter = new TextToolCallFilter();
    const r0 = filter.push('Start ');
    expect(r0.text).toBe('Start ');
    filter.push('<tool_ca');
    filter.push('ll' + String.fromCharCode(62) + FN_OPEN);
    filter.push('ls' + String.fromCharCode(62) + PM_OPEN + 'path');
    const last = filter.push(String.fromCharCode(62) + '/src' + PM_CLOSE + TC_CLOSE);
    expect(last.text).toBe('');
    expect(last.calls).toHaveLength(1);
    expect(last.calls[0].name).toBe('ls');
    const result = filter.flush();
    expect(result.text).toBe('');
    expect(result.calls).toEqual([]);
  });

  it('assigns sequential ids', () => {
    const filter = new TextToolCallFilter();
    const r1 = filter.push(tc('a', {}));
    const r2 = filter.push(tc('b', {}));
    expect(r1.calls[0].id).not.toBe(r2.calls[0].id);
  });
});

const SEC_OPEN = '<|tool_calls_section_begin|>';
const SEC_CLOSE = '<|tool_calls_section_end|>';
const CALL_OPEN = '<|tool_call_begin|>';
const CALL_ARG = '<|tool_call_argument_begin|>';
const CALL_CLOSE = '<|tool_call_end|>';

function tokenCall(id: string, args: string) {
  return `${CALL_OPEN} ${id} ${CALL_ARG} ${args} ${CALL_CLOSE}`;
}

describe('TextToolCallFilter (token format)', () => {
  it('extracts a complete sectioned tool call', () => {
    const filter = new TextToolCallFilter();
    const block =
      SEC_OPEN +
      tokenCall('functions.mcp_gitkraken_cli_git_status:4', '{"directory": "/Users/x/proj"}') +
      SEC_CLOSE;
    const result = filter.push(block);
    expect(result.text).toBe('');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('mcp_gitkraken_cli_git_status');
    expect(JSON.parse(result.calls[0].input)).toEqual({ directory: '/Users/x/proj' });
  });

  it('extracts multiple calls from one section', () => {
    const filter = new TextToolCallFilter();
    const block =
      'Running tools now ' +
      SEC_OPEN +
      tokenCall('functions.ls:0', '{"path": "/a"}') +
      tokenCall('functions.view:1', '{"path": "/b"}') +
      SEC_CLOSE;
    const result = filter.push(block);
    expect(result.text).toBe('Running tools now ');
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].name).toBe('ls');
    expect(result.calls[1].name).toBe('view');
  });

  it('handles a bare call without section wrapper', () => {
    const filter = new TextToolCallFilter();
    const result = filter.push(tokenCall('functions.grep:0', '{"pattern": "foo"}'));
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('grep');
    expect(JSON.parse(result.calls[0].input)).toEqual({ pattern: 'foo' });
  });

  it('holds back a partial section marker across deltas', () => {
    const filter = new TextToolCallFilter();
    const r1 = filter.push('Hello <|tool_call');
    expect(r1.text).toBe('Hello ');
    expect(r1.calls).toEqual([]);
    const r2 = filter.push(
      's_section_begin|>' + tokenCall('functions.ls:0', '{"path": "/a"}') + SEC_CLOSE,
    );
    expect(r2.text).toBe('');
    expect(r2.calls).toHaveLength(1);
    expect(r2.calls[0].name).toBe('ls');
  });

  it('holds an incomplete section until it closes', () => {
    const filter = new TextToolCallFilter();
    const r1 = filter.push(SEC_OPEN + CALL_OPEN + ' functions.ls:0 ' + CALL_ARG + ' {"pa');
    expect(r1.text).toBe('');
    expect(r1.calls).toEqual([]);
    const r2 = filter.push('th": "/a"} ' + CALL_CLOSE + SEC_CLOSE);
    expect(r2.calls).toHaveLength(1);
    expect(JSON.parse(r2.calls[0].input)).toEqual({ path: '/a' });
  });

  it('flush recovers an unterminated call', () => {
    const filter = new TextToolCallFilter();
    filter.push(SEC_OPEN + CALL_OPEN + ' functions.ls:2 ' + CALL_ARG + ' {"path": "/a"}');
    const result = filter.flush();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('ls');
    expect(JSON.parse(result.calls[0].input)).toEqual({ path: '/a' });
  });

  it('keeps names without the functions. prefix intact', () => {
    const filter = new TextToolCallFilter();
    const result = filter.push(SEC_OPEN + tokenCall('bash:0', '{"command": "ls"}') + SEC_CLOSE);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('bash');
  });

  it('emits an unparseable section as text', () => {
    const filter = new TextToolCallFilter();
    const block = SEC_OPEN + ' garbage without call markers ' + SEC_CLOSE;
    const result = filter.push(block);
    expect(result.calls).toEqual([]);
    expect(result.text).toBe(block);
  });
});

const MM_OPEN = '<minimax:tool_call>';
const MM_CLOSE = '</minimax:tool_call>';

function mmCall(name: string, params: Record<string, string>) {
  let block = `<invoke name="${name}">`;
  for (const [k, v] of Object.entries(params)) {
    block += `<parameter name="${k}">${v}</parameter>`;
  }
  block += '</invoke>';
  return block;
}

describe('TextToolCallFilter (minimax format)', () => {
  it('extracts a complete tool call', () => {
    const filter = new TextToolCallFilter();
    const result = filter.push(MM_OPEN + mmCall('ls', { path: '/src' }) + MM_CLOSE);
    expect(result.text).toBe('');
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('ls');
    expect(JSON.parse(result.calls[0].input)).toEqual({ path: '/src' });
  });

  it('extracts multiple invokes from one block', () => {
    const filter = new TextToolCallFilter();
    const block =
      'Before ' +
      MM_OPEN +
      mmCall('ls', { path: '/a' }) +
      mmCall('view', { path: '/b' }) +
      MM_CLOSE;
    const result = filter.push(block);
    expect(result.text).toBe('Before ');
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0].name).toBe('ls');
    expect(result.calls[1].name).toBe('view');
  });

  it('parses JSON parameter values into structures', () => {
    const filter = new TextToolCallFilter();
    const todos = '[{"content":"Explore MCP","id":"1","priority":"high","status":"completed"}]';
    const result = filter.push(MM_OPEN + mmCall('todowrite', { todos }) + MM_CLOSE);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('todowrite');
    const input = JSON.parse(result.calls[0].input);
    expect(input.todos).toEqual([
      { content: 'Explore MCP', id: '1', priority: 'high', status: 'completed' },
    ]);
  });

  it('tolerates unquoted names and missing closing tags', () => {
    const filter = new TextToolCallFilter();
    const block = MM_OPEN + '<invoke name=ls><parameter name=path>/src' + MM_CLOSE;
    const result = filter.push(block);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('ls');
    expect(JSON.parse(result.calls[0].input)).toEqual({ path: '/src' });
  });

  it('holds back a partial open tag across deltas', () => {
    const filter = new TextToolCallFilter();
    const r1 = filter.push('Hello <minimax:tool_ca');
    expect(r1.text).toBe('Hello ');
    expect(r1.calls).toEqual([]);
    const r2 = filter.push('ll>' + mmCall('ls', { path: '/a' }) + MM_CLOSE);
    expect(r2.text).toBe('');
    expect(r2.calls).toHaveLength(1);
    expect(r2.calls[0].name).toBe('ls');
  });

  it('flush recovers an unterminated block', () => {
    const filter = new TextToolCallFilter();
    filter.push(MM_OPEN + '<invoke name="grep"><parameter name="pattern">foo</parameter>');
    const result = filter.flush();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].name).toBe('grep');
    expect(JSON.parse(result.calls[0].input)).toEqual({ pattern: 'foo' });
  });

  it('emits a block without invokes as text', () => {
    const filter = new TextToolCallFilter();
    const block = MM_OPEN + ' nothing useful ' + MM_CLOSE;
    const result = filter.push(block);
    expect(result.calls).toEqual([]);
    expect(result.text).toBe(block);
  });
});

describe('TextToolCallFilter (garbage tool names)', () => {
  it('does not turn an ellipsis function name into a call (xml)', () => {
    const filter = new TextToolCallFilter();
    const block =
      TC_OPEN + String.fromCharCode(62) + FN_OPEN + '...' + String.fromCharCode(62) + TC_CLOSE;
    const result = filter.push(block);
    expect(result.calls).toEqual([]);
    expect(result.text).toBe(block);
  });

  it('does not turn an ellipsis invoke name into a call (minimax)', () => {
    const filter = new TextToolCallFilter();
    const block = MM_OPEN + '<invoke name="...">' + MM_CLOSE;
    const result = filter.push(block);
    expect(result.calls).toEqual([]);
    expect(result.text).toBe(block);
  });
});
