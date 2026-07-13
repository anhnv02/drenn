import { describe, it, expect, beforeEach } from 'vitest';
import { TodoWriteTool, getTodos, clearTodos, type TodoItem } from '../../../main/tools/todowrite';
import type { ExecutionContext, ToolCall } from '../../../main/tools/types';

function makeCtx(sessionId = 'test-session'): ExecutionContext {
  return {
    sessionId,
    messageId: 'msg-1',
    cwd: '/project',
    permissions: {} as any,
    mode: 'default',
  };
}

function makeCall(todos: TodoItem[]): ToolCall {
  return {
    id: 'call-1',
    name: 'todowrite',
    input: JSON.stringify({ todos }),
  };
}

describe('TodoWriteTool', () => {
  const tool = new TodoWriteTool();

  beforeEach(() => {
    clearTodos('test-session');
  });

  it('returns correct tool info', () => {
    const info = tool.info();
    expect(info.name).toBe('todowrite');
    expect(info.required).toContain('todos');
  });

  it('creates new todos', async () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'Task 1', status: 'pending', priority: 'high' },
      { id: '2', content: 'Task 2', status: 'in_progress', priority: 'medium' },
    ];
    const result = await tool.run(makeCtx(), makeCall(todos));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Task 1');
    expect(result.content).toContain('Task 2');
    expect(result.content).toContain('[HIGH]');
    expect(result.content).toContain('[MED]');
  });

  it('updates existing todo', async () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Task 1', status: 'pending', priority: 'high' }];
    await tool.run(makeCtx(), makeCall(todos));

    const updated: TodoItem[] = [
      { id: '1', content: 'Task 1', status: 'completed', priority: 'high' },
    ];
    const result = await tool.run(makeCtx(), makeCall(updated));
    expect(result.isError).toBe(false);
    expect(result.content).toContain('\u2713');
  });

  it('returns error for non-array todos', async () => {
    const call: ToolCall = {
      id: 'call-1',
      name: 'todowrite',
      input: JSON.stringify({ todos: 'not-an-array' }),
    };
    const result = await tool.run(makeCtx(), call);
    expect(result.isError).toBe(true);
  });

  it('returns error for invalid JSON', async () => {
    const call: ToolCall = {
      id: 'call-1',
      name: 'todowrite',
      input: 'invalid-json',
    };
    const result = await tool.run(makeCtx(), call);
    expect(result.isError).toBe(true);
  });

  it('shows correct status icons', async () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'Pending', status: 'pending', priority: 'low' },
      { id: '2', content: 'Active', status: 'in_progress', priority: 'low' },
      { id: '3', content: 'Done', status: 'completed', priority: 'low' },
    ];
    const result = await tool.run(makeCtx(), makeCall(todos));
    expect(result.content).toContain('\u25CB Pending');
    expect(result.content).toContain('\u25CF Active');
    expect(result.content).toContain('\u2713 Done');
  });
});

describe('getTodos / clearTodos', () => {
  beforeEach(() => {
    clearTodos('session-1');
  });

  it('returns empty array for unknown session', () => {
    expect(getTodos('unknown')).toEqual([]);
  });

  it('clears todos for session', async () => {
    const tool = new TodoWriteTool();
    const todos: TodoItem[] = [{ id: '1', content: 'Task', status: 'pending', priority: 'low' }];
    await tool.run(makeCtx('session-1'), makeCall(todos));
    expect(getTodos('session-1')).toHaveLength(1);
    clearTodos('session-1');
    expect(getTodos('session-1')).toEqual([]);
  });
});
