import type { FileChange } from '../../../shared/types';

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  files: FileChange[];
  ignored: boolean;
}

export function buildFileTree(files: FileChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], files: [], ignored: false };

  for (const file of files) {
    const segments = file.dir ? file.dir.split('/') : [];
    let node = root;
    let path = '';
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      let child = node.children.find((c) => c.name === segment);
      if (!child) {
        child = { name: segment, path, children: [], files: [], ignored: false };
        node.children.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }

  markIgnored(root);
  return root;
}

function markIgnored(node: TreeNode): boolean {
  const childrenIgnored = node.children.map(markIgnored);
  const everyChildIgnored = childrenIgnored.every(Boolean);
  const everyFileIgnored = node.files.every((f) => f.ignored);
  const hasEntries = node.children.length > 0 || node.files.length > 0;
  node.ignored = hasEntries && everyChildIgnored && everyFileIgnored;
  return node.ignored;
}

export function collectFolderPaths(node: TreeNode, paths: string[] = []): string[] {
  for (const child of node.children) {
    paths.push(child.path);
    collectFolderPaths(child, paths);
  }
  return paths;
}
