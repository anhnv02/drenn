import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import type { DiffContent, FileChange, FileStatus } from '../shared/types';

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  mdx: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  php: 'php',
  lua: 'lua',
  r: 'r',
  R: 'r',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  dockerfile: 'dockerfile',
  Dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'plaintext',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  lhs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  tf: 'hcl',
  tfvars: 'hcl',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'shell',
  txt: 'plaintext',
  log: 'plaintext',
  lock: 'plaintext',
  gitignore: 'plaintext',
  editorconfig: 'ini',
  prettierrc: 'json',
  eslintrc: 'json',
  babelrc: 'json',
};

export function languageFor(path: string): string {
  const base = basename(path);
  if (base === 'Dockerfile' || base === 'Containerfile') return 'dockerfile';
  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGE[ext] ?? 'plaintext';
}

const MAX_TREE_FILES = 20_000;

function toEntry(path: string, ignored: boolean): FileChange {
  const slash = path.lastIndexOf('/');
  return {
    path,
    dir: slash === -1 ? '' : path.slice(0, slash),
    name: slash === -1 ? path : path.slice(slash + 1),
    added: 0,
    removed: 0,
    ignored,
  };
}

function findIgnored(cwd: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['check-ignore', '--stdin'],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
      (_error, stdout) => resolve(new Set(stdout.split('\n').filter(Boolean))),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(paths.join('\n'));
  });
}

const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

async function walkDir(root: string): Promise<string[]> {
  const paths: string[] = [];
  const stack = [''];
  while (stack.length && paths.length < MAX_TREE_FILES) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) paths.push(childRel);
    }
  }
  return paths.sort();
}

export async function listFilesFor(cwd: string | null): Promise<FileChange[]> {
  if (!cwd) return [];
  const paths = await walkDir(cwd);
  const ignored = await findIgnored(cwd, paths);
  return paths.map((path) => toEntry(path, ignored.has(path)));
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
}

export async function getUncommittedChanges(cwd: string | null): Promise<FileChange[]> {
  if (!cwd) return [];
  const [nameStatusOut, numstatOut, untrackedOut] = await Promise.all([
    execGit(cwd, ['diff', '--name-status', 'HEAD']),
    execGit(cwd, ['diff', '--numstat', 'HEAD']),
    execGit(cwd, ['ls-files', '--others', '--exclude-standard']),
  ]);
  if (!nameStatusOut && !untrackedOut) return [];

  const statusByPath = new Map<string, FileStatus>();
  for (const line of nameStatusOut.split('\n')) {
    if (!line) continue;
    const fields = line.split('\t');
    const path = fields[fields.length - 1];
    if (!path) continue;
    const letter = fields[0][0];
    statusByPath.set(path, letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M');
  }

  const countsByPath = new Map<string, { added: number; removed: number }>();
  for (const line of numstatOut.split('\n')) {
    if (!line) continue;
    const [addedStr, removedStr, ...rest] = line.split('\t');
    const path = rest[rest.length - 1];
    if (!path) continue;
    countsByPath.set(path, {
      added: addedStr === '-' ? 0 : Number(addedStr) || 0,
      removed: removedStr === '-' ? 0 : Number(removedStr) || 0,
    });
  }

  const files: FileChange[] = [];
  for (const [path, status] of statusByPath) {
    const counts = countsByPath.get(path) ?? { added: 0, removed: 0 };
    files.push({ ...toEntry(path, false), added: counts.added, removed: counts.removed, status });
  }

  for (const path of untrackedOut.split('\n')) {
    if (!path || statusByPath.has(path)) continue;
    const content = await readFile(join(cwd, path), 'utf8').catch(() => null);
    const added = content ? content.split('\n').length : 0;
    files.push({ ...toEntry(path, false), added, removed: 0, status: 'A' });
  }

  return files;
}

export async function getDiffFor(cwd: string, path: string): Promise<DiffContent> {
  const absPath = isAbsolute(path) ? path : join(cwd, path);

  let before = '';
  if (!isAbsolute(path)) {
    before = await new Promise<string>((resolve) => {
      execFile(
        'git',
        ['show', `HEAD:${path}`],
        { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5_000 },
        (error, stdout) => resolve(error ? '' : stdout),
      );
    });
  }

  const after = await readFile(absPath, 'utf8').catch(() => '');

  return { path, before, after, language: languageFor(path), source: 'disk' };
}
