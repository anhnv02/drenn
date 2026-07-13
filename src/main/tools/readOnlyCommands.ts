import * as path from 'path';

const READ_ONLY_COMMANDS = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'which',
  'whereis',
  'echo',
  'printf',
  'date',
  'uname',
  'whoami',
  'id',
  'hostname',
  'ps',
  'true',
  'false',
  'test',
  'md5',
  'shasum',
  'cksum',
  'strings',
  'column',
  'nl',
  'less',
  'more',
  'git',
  'find',
  'sort',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
  'count-objects',
  'version',
  'check-ignore',
  'merge-base',
]);

const GIT_FLAG_ONLY_SUBCOMMANDS = new Set(['branch', 'remote', 'tag', 'stash']);

const UNSAFE_FIND_ARGS = /^-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)$/;

const HARMLESS_REDIRECTS = /\d*>{1,2}\s*(&\d+|\/dev\/null)/g;

const ENV_ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/;

function isReadOnlyGit(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  }
  const sub = args[i];
  if (!sub) return false;
  const rest = args.slice(i + 1);
  if (rest.some((a) => a.startsWith('--output'))) return false;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return true;
  if (GIT_FLAG_ONLY_SUBCOMMANDS.has(sub)) {
    if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
    return rest.every((a) => a.startsWith('-'));
  }
  return false;
}

function isReadOnlySegment(segment: string): boolean {
  let s = segment.trim();
  s = s.replace(/^[()\s]+/, '');
  for (;;) {
    const stripped = s.replace(ENV_ASSIGNMENT_PREFIX, '');
    if (stripped === s) break;
    s = stripped;
  }
  if (s === '') return true;

  const tokens = s.split(/\s+/);
  const head = path.basename(tokens[0].replace(/^["']|["']$/g, ''));
  if (!READ_ONLY_COMMANDS.has(head)) return false;

  const args = tokens.slice(1);
  if (head === 'git') return isReadOnlyGit(args);
  if (head === 'find') return !args.some((a) => UNSAFE_FIND_ARGS.test(a));
  if (head === 'sort') return !args.some((a) => a === '-o' || a.startsWith('--output'));
  return true;
}

export function splitCommandSegments(command: string): string[] {
  return command
    .replace(HARMLESS_REDIRECTS, ' ')
    .replace(/\$\(|<\(|`/g, '\n')
    .split(/\|\|?|&&?|;|\r|\n/)
    .map((s) => s.trim().replace(/^[()\s]+/, ''))
    .filter((s) => s !== '');
}

export function hasFileRedirect(command: string): boolean {
  return />/.test(command.replace(HARMLESS_REDIRECTS, ' '));
}

export function isReadOnlyCommand(command: string): boolean {
  if (hasFileRedirect(command)) return false;
  return splitCommandSegments(command).every(isReadOnlySegment);
}
