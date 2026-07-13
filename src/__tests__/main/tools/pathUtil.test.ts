import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { isExternalPath } from '../../../main/tools/pathUtil';

describe('isExternalPath', () => {
  it('returns false for path inside cwd', () => {
    expect(isExternalPath('/project', '/project/src/file.ts')).toBe(false);
  });

  it('returns true for path outside cwd', () => {
    expect(isExternalPath('/project', '/other/file.ts')).toBe(true);
  });

  it('returns true for parent directory traversal', () => {
    expect(isExternalPath('/project', join('/project', '..', 'secret.ts'))).toBe(true);
  });

  it('returns false for cwd itself', () => {
    expect(isExternalPath('/project', '/project')).toBe(false);
  });

  it('returns true for sibling directory', () => {
    expect(isExternalPath('/project/a', '/project/b/file.ts')).toBe(true);
  });

  it('handles nested paths correctly', () => {
    expect(isExternalPath('/project', '/project/src/deep/nested/file.ts')).toBe(false);
  });

  it('handles absolute path in different root', () => {
    expect(isExternalPath('/home/user/project', '/etc/passwd')).toBe(true);
  });
});
