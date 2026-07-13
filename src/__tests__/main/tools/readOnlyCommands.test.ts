import { describe, it, expect } from 'vitest';
import { isReadOnlyCommand } from '../../../main/tools/readOnlyCommands';

describe('isReadOnlyCommand', () => {
  describe('simple read-only commands', () => {
    it.each([
      'ls',
      'ls -la src',
      'pwd',
      'cat package.json',
      'head -n 20 src/main/index.ts',
      'grep -rn "foo" src',
      'rg --files-with-matches pattern',
      'wc -l file.txt',
      'find src -name "*.ts"',
      'diff a.txt b.txt',
      'which node',
      'echo hello',
      'stat file.txt',
      'tree -L 2',
    ])('allows %s', (cmd) => {
      expect(isReadOnlyCommand(cmd)).toBe(true);
    });
  });

  describe('mutating or unknown commands', () => {
    it.each([
      'rm -rf /',
      'mv a b',
      'cp a b',
      'touch file',
      'mkdir dir',
      'chmod +x script.sh',
      'npm install',
      'npx tsc --noEmit',
      'node script.js',
      'python3 -c "print(1)"',
      'sh -c "ls"',
      'bash script.sh',
      'sed -i "" "s/a/b/" file',
      'awk "{system(\\"rm x\\")}" file',
      'xargs rm',
      'env rm file',
      'tee out.txt',
    ])('rejects %s', (cmd) => {
      expect(isReadOnlyCommand(cmd)).toBe(false);
    });
  });

  describe('git', () => {
    it.each([
      'git status',
      'git log --oneline -20',
      'git diff HEAD~1',
      'git show HEAD:src/main/index.ts',
      'git blame src/main/index.ts',
      'git rev-parse HEAD',
      'git ls-files',
      'git -C /some/repo log',
      'git -c core.pager=cat log',
      'git branch -a',
      'git branch --show-current',
      'git remote -v',
      'git stash list',
      'git merge-base HEAD develop',
    ])('allows %s', (cmd) => {
      expect(isReadOnlyCommand(cmd)).toBe(true);
    });

    it.each([
      'git commit -m "x"',
      'git add .',
      'git push',
      'git checkout -b new',
      'git reset --hard HEAD~1',
      'git branch new-branch',
      'git remote add origin url',
      'git tag v1.0.0',
      'git stash',
      'git stash pop',
      'git log --output=/tmp/x',
      'git',
    ])('rejects %s', (cmd) => {
      expect(isReadOnlyCommand(cmd)).toBe(false);
    });
  });

  describe('chaining and pipes', () => {
    it('allows pipelines of read-only segments', () => {
      expect(isReadOnlyCommand('git log --oneline | head -5')).toBe(true);
      expect(isReadOnlyCommand('grep -rn foo src | wc -l')).toBe(true);
      expect(isReadOnlyCommand('ls && pwd; git status')).toBe(true);
    });

    it('rejects when any segment mutates', () => {
      expect(isReadOnlyCommand('ls; rm -rf ~')).toBe(false);
      expect(isReadOnlyCommand('git log && git push')).toBe(false);
      expect(isReadOnlyCommand('cat file | tee out.txt')).toBe(false);
      expect(isReadOnlyCommand('ls & rm x')).toBe(false);
    });

    it('validates the inner command of substitutions', () => {
      expect(isReadOnlyCommand('git show $(git rev-parse HEAD)')).toBe(true);
      expect(isReadOnlyCommand('echo $(rm -rf /)')).toBe(false);
      expect(isReadOnlyCommand('echo `rm x`')).toBe(false);
      expect(isReadOnlyCommand('diff <(git show HEAD:a) <(cat a)')).toBe(true);
    });
  });

  describe('redirection', () => {
    it('rejects output redirects to files', () => {
      expect(isReadOnlyCommand('echo hi > file.txt')).toBe(false);
      expect(isReadOnlyCommand('git log >> log.txt')).toBe(false);
      expect(isReadOnlyCommand('cat a 2> err.log')).toBe(false);
    });

    it('allows harmless fd/devnull redirects and input redirects', () => {
      expect(isReadOnlyCommand('git status 2>&1')).toBe(true);
      expect(isReadOnlyCommand('ls > /dev/null')).toBe(true);
      expect(isReadOnlyCommand('grep foo 2>/dev/null')).toBe(true);
      expect(isReadOnlyCommand('sort < input.txt')).toBe(true);
    });
  });

  describe('argument-dependent commands', () => {
    it('rejects find with executing/writing actions', () => {
      expect(isReadOnlyCommand('find . -name "*.tmp" -delete')).toBe(false);
      expect(isReadOnlyCommand('find . -name "*.ts" -exec rm {} \\;')).toBe(false);
    });

    it('rejects sort with output file', () => {
      expect(isReadOnlyCommand('sort -o out.txt in.txt')).toBe(false);
      expect(isReadOnlyCommand('sort in.txt')).toBe(true);
    });
  });

  describe('env assignments and paths', () => {
    it('allows leading VAR=value assignments', () => {
      expect(isReadOnlyCommand('GIT_PAGER=cat git log')).toBe(true);
      expect(isReadOnlyCommand('FOO=1 BAR=2 ls')).toBe(true);
    });

    it('resolves absolute command paths by basename', () => {
      expect(isReadOnlyCommand('/bin/ls -la')).toBe(true);
      expect(isReadOnlyCommand('/bin/rm x')).toBe(false);
    });
  });
});
