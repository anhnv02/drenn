import { describe, it, expect } from 'vitest';
import { stitchDoc, buildSessionDiff } from '../../shared/sessionDiff';

describe('stitchDoc', () => {
  it('returns single text as-is', () => {
    expect(stitchDoc(['hello'])).toBe('hello');
  });

  it('joins multiple texts with headers', () => {
    const result = stitchDoc(['aaa', 'bbb', 'ccc']);
    expect(result).toContain('··· edit 1 of 3 ···');
    expect(result).toContain('··· edit 2 of 3 ···');
    expect(result).toContain('··· edit 3 of 3 ···');
    expect(result.startsWith('··· edit 1 of 3 ···\naaa')).toBe(true);
  });

  it('preserves text content between headers', () => {
    const result = stitchDoc(['first', 'second']);
    expect(result).toContain('first');
    expect(result).toContain('second');
  });
});

describe('buildSessionDiff', () => {
  it('returns null for empty ops', () => {
    expect(buildSessionDiff([])).toBeNull();
  });

  it('builds before/after from single op', () => {
    const ops = [{ before: 'old', after: 'new' }];
    const diff = buildSessionDiff(ops);
    expect(diff).not.toBeNull();
    expect(diff!.before).toBe('old');
    expect(diff!.after).toBe('new');
  });

  it('stitches multiple ops with headers', () => {
    const ops = [
      { before: 'old1', after: 'new1' },
      { before: 'old2', after: 'new2' },
    ];
    const diff = buildSessionDiff(ops);
    expect(diff).not.toBeNull();
    expect(diff!.before).toContain('··· edit 1 of 2 ···');
    expect(diff!.before).toContain('old1');
    expect(diff!.before).toContain('··· edit 2 of 2 ···');
    expect(diff!.before).toContain('old2');
    expect(diff!.after).toContain('new1');
    expect(diff!.after).toContain('new2');
  });

  it('headers are symmetric between before and after', () => {
    const ops = [
      { before: 'a', after: 'x' },
      { before: 'b', after: 'y' },
    ];
    const diff = buildSessionDiff(ops);
    const beforeHeaders = diff!.before.match(/··· edit \d+ of \d+ ···/g);
    const afterHeaders = diff!.after.match(/··· edit \d+ of \d+ ···/g);
    expect(beforeHeaders).toEqual(afterHeaders);
  });
});
