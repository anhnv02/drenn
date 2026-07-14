import { useEffect, useState } from 'react';
import { api } from '../api';
import { Codicon } from './Codicon';
import type { TodoItem } from '../../../shared/types';
import './TodoList.css';

interface TodoListProps {
  sessionId: string;
}

export function TodoList({ sessionId }: TodoListProps) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    api.getTodos(sessionId).then(({ todos }) => setTodos(todos));

    const interval = setInterval(() => {
      api.getTodos(sessionId).then(({ todos }) => setTodos(todos));
    }, 3000);

    return () => clearInterval(interval);
  }, [sessionId]);

  if (todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;

  return (
    <div className="todo-list">
      <div className="todo-header" onClick={() => setCollapsed((c) => !c)}>
        <Codicon name="check-all" size={14} className="todo-header-icon" />
        <span className="todo-header-title">TODO</span>
        <span className="todo-header-stats">
          {completedCount}/{todos.length} done
          {inProgressCount > 0 && ` · ${inProgressCount} in progress`}
        </span>
        <button
          className="todo-collapse-btn"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
          aria-label={collapsed ? 'Expand TODO list' : 'Collapse TODO list'}
        >
          <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
      </div>
      {!collapsed && (
        <div className="todo-items">
          {todos.map((todo) => (
            <div key={todo.id} className={`todo-item todo-item-${todo.status}`}>
              <span className="todo-item-status">
                {todo.status === 'completed' ? (
                  <Codicon name="pass" size={12} className="todo-icon-completed" />
                ) : todo.status === 'in_progress' ? (
                  <Codicon name="loading" size={12} className="todo-icon-progress" />
                ) : (
                  <Codicon name="circle-outline" size={12} className="todo-icon-pending" />
                )}
              </span>
              <span className="todo-item-content">
                {todo.content}
                {todo.priority === 'high' && (
                  <span className="todo-priority-high">high</span>
                )}
                {todo.priority === 'medium' && (
                  <span className="todo-priority-medium">med</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}