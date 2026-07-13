import { describe, it, expect } from 'vitest';
import {
  countLineDiff,
  accumulate,
  toFileChanges,
  sumEditCounts,
  type FileChangeAcc,
} from '../../../main/history/changeUtils';

describe('sumEditCounts', () => {
  it('sums edits and writes across entries', () => {
    expect(
      sumEditCounts([
        { filePath: '/a.ts', tool: 'edit', oldString: 'a\nb', newString: 'a\nc\nd' },
        { filePath: '/b.ts', tool: 'write', content: 'x\ny\nz' },
      ]),
    ).toEqual({ added: 5, removed: 1 });
  });

  it('returns zeros for no entries', () => {
    expect(sumEditCounts([])).toEqual({ added: 0, removed: 0 });
  });
});

describe('countLineDiff', () => {
  it('identical strings return zero diff', () => {
    expect(countLineDiff('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });

  it('counts added lines', () => {
    expect(countLineDiff('a', 'a\nb\n')).toEqual({ added: 2, removed: 0 });
  });

  it('counts removed lines', () => {
    expect(countLineDiff('a\nb', 'a')).toEqual({ added: 0, removed: 1 });
  });

  it('counts mixed changes', () => {
    expect(countLineDiff('a\nb\nc', 'a\nd\nc')).toEqual({ added: 1, removed: 1 });
  });

  it('handles empty old string', () => {
    expect(countLineDiff('', 'a\nb')).toEqual({ added: 2, removed: 0 });
  });

  it('handles empty new string', () => {
    expect(countLineDiff('a\nb', '')).toEqual({ added: 0, removed: 2 });
  });

  it('handles both empty', () => {
    expect(countLineDiff('', '')).toEqual({ added: 0, removed: 0 });
  });

  it('single line change', () => {
    expect(countLineDiff('hello', 'world')).toEqual({ added: 1, removed: 1 });
  });

  it('handles large inputs with fallback', () => {
    const old = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const newStr = Array.from({ length: 2000 }, (_, i) => `b${i}`).join('\n');
    const result = countLineDiff(old, newStr);
    expect(result.added).toBe(2000);
    expect(result.removed).toBe(3000);
  });
});

describe('accumulate', () => {
  it('creates new entry', () => {
    const m = new Map<string, FileChangeAcc>();
    accumulate(m, 'file.ts', 5, 3, true);
    expect(m.get('file.ts')).toEqual({ added: 5, removed: 3, created: true });
  });

  it('merges with existing entry', () => {
    const m = new Map<string, FileChangeAcc>();
    accumulate(m, 'file.ts', 5, 3, true);
    accumulate(m, 'file.ts', 2, 1, false);
    expect(m.get('file.ts')).toEqual({ added: 7, removed: 4, created: true });
  });

  it('handles multiple different paths', () => {
    const m = new Map<string, FileChangeAcc>();
    accumulate(m, 'a.ts', 1, 0, false);
    accumulate(m, 'b.ts', 0, 1, false);
    expect(m.size).toBe(2);
  });
});

describe('toFileChanges', () => {
  it('converts map to FileChange array', () => {
    const m = new Map<string, FileChangeAcc>();
    m.set('/project/src/index.ts', { added: 5, removed: 2, created: false });
    const changes = toFileChanges(m, '/project');
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('src/index.ts');
    expect(changes[0].dir).toBe('src');
    expect(changes[0].name).toBe('index.ts');
    expect(changes[0].added).toBe(5);
    expect(changes[0].removed).toBe(2);
    expect(changes[0].status).toBe('M');
  });

  it('marks created files with status A when file exists', () => {
    const existingFile = import.meta.filename;
    const m = new Map<string, FileChangeAcc>();
    m.set(existingFile, { added: 10, removed: 0, created: true });
    const changes = toFileChanges(m, null);
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe('A');
  });

  it('skips created files that no longer exist on disk', () => {
    const m = new Map<string, FileChangeAcc>();
    m.set('/nonexistent/path/that/should/not/exist.ts', { added: 10, removed: 0, created: true });
    const changes = toFileChanges(m, null);
    expect(changes).toHaveLength(0);
  });

  it('handles files with no directory', () => {
    const m = new Map<string, FileChangeAcc>();
    m.set('README.md', { added: 1, removed: 0, created: false });
    const changes = toFileChanges(m, null);
    expect(changes[0].dir).toBe('');
    expect(changes[0].name).toBe('README.md');
  });

  it('handles null cwd', () => {
    const m = new Map<string, FileChangeAcc>();
    m.set('/absolute/path.ts', { added: 1, removed: 0, created: false });
    const changes = toFileChanges(m, null);
    expect(changes[0].path).toBe('/absolute/path.ts');
  });
});
