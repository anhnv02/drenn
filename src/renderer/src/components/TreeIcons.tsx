import { Codicon } from './Codicon';

export function FileIcon({ name }: { name: string }) {
  return <Codicon name="file" size={15} className="tree-icon" />;
}

export function FolderIcon({ open }: { open: boolean }) {
  return <Codicon name={open ? 'folder-opened' : 'folder'} size={15} className="tree-icon" />;
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <Codicon name="chevron-right" size={10} className={`tree-chevron-icon${open ? ' open' : ''}`} />
  );
}
