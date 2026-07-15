import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { parseToolInput } from '../../shared/utils/json';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

const todoStore = new Map<string, TodoItem[]>();

export class TodoWriteTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'todowrite',
      description: `Create and manage a structured task list for the current session. Use it to track progress and give the user visibility into your plan.

When to use: complex tasks with 3+ distinct steps, or when the user gives you multiple tasks.
When NOT to use: a single straightforward task — doing it is faster than tracking it.

Usage:
- Mark a task in_progress BEFORE starting it, and keep exactly ONE task in_progress at a time.
- Mark a task completed IMMEDIATELY after finishing it — do not batch up completions.
- Only mark completed when it is actually done (tests pass, no errors). If you hit a blocker, keep the task in_progress and add a new task describing the blocker.
- Todos are merged by id: send only the todos you are adding or updating (with id, content, status, priority); existing ones are kept.`,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['id', 'content', 'status', 'priority'],
            },
            description: 'Array of todo items to create or update',
          },
        },
        required: ['todos'],
      },
      required: ['todos'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = parseToolInput<{
        todos?: Array<{
          id: string;
          content: string;
          status: 'pending' | 'in_progress' | 'completed';
          priority: 'high' | 'medium' | 'low';
        }>;
      }>(call.input);
      const { todos } = params;

      if (!Array.isArray(todos)) {
        return { content: 'Error: todos must be an array', isError: true };
      }

      // Get existing todos for this session
      const existingTodos = todoStore.get(ctx.sessionId) || [];

      // Merge new todos
      for (const newTodo of todos) {
        const existingIndex = existingTodos.findIndex((t) => t.id === newTodo.id);
        if (existingIndex >= 0) {
          existingTodos[existingIndex] = newTodo;
        } else {
          existingTodos.push(newTodo);
        }
      }

      todoStore.set(ctx.sessionId, existingTodos);

      // Format output
      const lines = existingTodos.map((todo) => {
        const icon = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○';
        const priority =
          todo.priority === 'high' ? ' [HIGH]' : todo.priority === 'medium' ? ' [MED]' : '';
        return `${icon} ${todo.content}${priority}`;
      });

      return {
        content: `Todo list updated:\n${lines.join('\n')}`,
        isError: false,
      };
    } catch (error) {
      return { content: `Error updating todos: ${error}`, isError: true };
    }
  }
}

export function getTodos(sessionId: string): TodoItem[] {
  return todoStore.get(sessionId) || [];
}

export function clearTodos(sessionId: string): void {
  todoStore.delete(sessionId);
}
