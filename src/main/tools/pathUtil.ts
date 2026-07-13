import * as path from 'path';

export function isExternalPath(cwd: string, resolvedPath: string): boolean {
  const rel = path.relative(cwd, resolvedPath);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}
