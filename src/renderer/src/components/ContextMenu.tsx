import { useEffect, useRef } from 'react';
import './ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  const menuX = Math.min(x, window.innerWidth - 200);
  const menuY = Math.min(y, window.innerHeight - items.length * 32);

  return (
    <div ref={ref} className="context-menu" style={{ left: menuX, top: menuY }} role="menu">
      {items.map((item, i) => (
        <div
          key={i}
          className={`context-menu-item${item.disabled ? ' disabled' : ''}`}
          role="menuitem"
          tabIndex={0}
          onClick={() => {
            if (!item.disabled) {
              item.action();
              onClose();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !item.disabled) {
              item.action();
              onClose();
            }
          }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
