import { describe, it, expect } from 'vitest';
import {
  matchPattern,
  checkPermissionPatterns,
  evaluateBashPatterns,
} from '../../../main/permission/patterns';

describe('matchPattern', () => {
  it('matches exact string', () => {
    expect(matchPattern('hello', 'hello')).toBe(true);
  });

  it('matches * wildcard', () => {
    expect(matchPattern('*', 'anything')).toBe(true);
    expect(matchPattern('*.ts', 'file.ts')).toBe(true);
    expect(matchPattern('*.ts', 'file.js')).toBe(false);
  });

  it('matches ? single char wildcard', () => {
    expect(matchPattern('?.ts', 'a.ts')).toBe(true);
    expect(matchPattern('?.ts', 'ab.ts')).toBe(false);
  });

  it('matches ** globstar', () => {
    expect(matchPattern('src/**', 'src/main/index.ts')).toBe(true);
    expect(matchPattern('**/*.ts', 'deep/nested/file.ts')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(matchPattern('HELLO', 'hello')).toBe(true);
    expect(matchPattern('hello', 'HELLO')).toBe(true);
  });

  it('handles special regex chars', () => {
    expect(matchPattern('file.ts', 'file.ts')).toBe(true);
    expect(matchPattern('file+test', 'file+test')).toBe(true);
    expect(matchPattern('file[0]', 'file[0]')).toBe(true);
  });

  it('rejects non-matching', () => {
    expect(matchPattern('foo', 'bar')).toBe(false);
    expect(matchPattern('*.ts', 'file.tsx')).toBe(false);
  });
});

describe('checkPermissionPatterns', () => {
  it('returns null for empty patterns', () => {
    expect(checkPermissionPatterns([], 'bash', 'ls')).toBeNull();
  });

  it('returns action for matching pattern', () => {
    const patterns = [{ pattern: 'bash *', action: 'allow' as const }];
    expect(checkPermissionPatterns(patterns, 'bash', 'ls')).toBe('allow');
  });

  it('matches tool + resource combination', () => {
    const patterns = [{ pattern: 'git status', action: 'allow' as const }];
    expect(checkPermissionPatterns(patterns, 'git', 'status')).toBe('allow');
    expect(checkPermissionPatterns(patterns, 'git', 'push')).toBeNull();
  });

  it('returns first matching action', () => {
    const patterns = [
      { pattern: 'bash *', action: 'allow' as const },
      { pattern: 'bash rm *', action: 'deny' as const },
    ];
    expect(checkPermissionPatterns(patterns, 'bash', 'ls')).toBe('allow');
  });

  it('supports deny action', () => {
    const patterns = [{ pattern: 'bash rm *', action: 'deny' as const }];
    expect(checkPermissionPatterns(patterns, 'bash', 'rm -rf /')).toBe('deny');
  });
});

describe('evaluateBashPatterns', () => {
  const allowGit = [{ pattern: 'git *', action: 'allow' as const }];

  it('allows a simple matching command', () => {
    expect(evaluateBashPatterns(allowGit, 'git status')).toBe('allow');
  });

  it('does not allow a compound command when only one segment matches', () => {
    expect(evaluateBashPatterns(allowGit, 'git status && rm -rf ~')).toBeNull();
    expect(evaluateBashPatterns(allowGit, 'git status; rm -rf ~')).toBeNull();
    expect(evaluateBashPatterns(allowGit, 'git status | sh')).toBeNull();
  });

  it('does not allow command substitution smuggling', () => {
    expect(evaluateBashPatterns(allowGit, 'git log $(rm -rf ~)')).toBeNull();
    expect(evaluateBashPatterns(allowGit, 'git log `rm -rf ~`')).toBeNull();
  });

  it('allows compound commands when every segment matches an allow rule', () => {
    const patterns = [
      { pattern: 'git *', action: 'allow' as const },
      { pattern: 'npm run *', action: 'allow' as const },
    ];
    expect(evaluateBashPatterns(patterns, 'git pull && npm run build')).toBe('allow');
  });

  it('deny wins when any segment matches a deny rule', () => {
    const patterns = [
      { pattern: 'git *', action: 'allow' as const },
      { pattern: 'rm *', action: 'deny' as const },
    ];
    expect(evaluateBashPatterns(patterns, 'git status && rm -rf ~')).toBe('deny');
  });

  it('ask on one segment beats allow on the others', () => {
    const patterns = [
      { pattern: 'git push*', action: 'ask' as const },
      { pattern: 'git *', action: 'allow' as const },
    ];
    expect(evaluateBashPatterns(patterns, 'git status && git push origin')).toBe('ask');
  });

  it('first matching rule wins per segment', () => {
    const patterns = [
      { pattern: 'git push*', action: 'deny' as const },
      { pattern: 'git *', action: 'allow' as const },
    ];
    expect(evaluateBashPatterns(patterns, 'git push origin main')).toBe('deny');
    expect(evaluateBashPatterns(patterns, 'git status')).toBe('allow');
  });

  it('never auto-allows output redirects, but still denies them', () => {
    expect(evaluateBashPatterns(allowGit, 'git log > /tmp/out.txt')).toBeNull();
    expect(evaluateBashPatterns(allowGit, 'git log 2>&1')).toBe('allow');
    expect(evaluateBashPatterns(allowGit, 'git log > /dev/null')).toBe('allow');
    const deny = [{ pattern: 'git *', action: 'deny' as const }];
    expect(evaluateBashPatterns(deny, 'git log > /tmp/out.txt')).toBe('deny');
  });

  it('returns null when nothing matches', () => {
    expect(evaluateBashPatterns(allowGit, 'ls -la')).toBeNull();
    expect(evaluateBashPatterns([], 'git status')).toBeNull();
  });
});
