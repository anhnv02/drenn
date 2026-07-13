/**
 * Standalone round-trip tests for pure parse/serialize functions.
 * Run:  node --test test/pure-roundtrip.mjs
 *
 * All logic is inlined here to avoid importing modules that pull in
 * electron-store, filesystem I/O, or other side-effecting deps.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── YAML frontmatter helpers (from src/main/agent/subagent/store.ts) ────────

function coerce(value) {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

function yamlScalar(s) {
  if (/[:#\n"']/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

function parseYamlish(raw) {
  const data = {};
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_.*?]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest === '') {
      const nested = {};
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        const nm = lines[i].trim().match(/^([A-Za-z0-9_.*?]+):\s*(.*)$/);
        i++;
        if (nm) {
          if (nm[2] === '') {
            // Deeper nesting: collect sub-nested map
            const subNested = {};
            while (i < lines.length && /^\s+\S/.test(lines[i])) {
              const subLine = lines[i].trim().match(/^([A-Za-z0-9_.*?]+):\s*(.*)$/);
              i++;
              if (subLine) subNested[subLine[1]] = coerce(subLine[2]);
            }
            nested[nm[1]] = Object.keys(subNested).length > 0 ? subNested : '';
          } else {
            nested[nm[1]] = coerce(nm[2]);
          }
        }
      }
      if (Object.keys(nested).length > 0) data[key] = nested;
    } else {
      data[key] = coerce(rest);
    }
  }
  return data;
}

function splitFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: normalized };
  const raw = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^[^\n]*\n?/, '');
  return { data: parseYamlish(raw), body };
}

function parseAgentMarkdown(name, text) {
  const { data, body } = splitFrontmatter(text);
  const mode = data.mode === 'primary' || data.mode === 'all' ? data.mode : 'subagent';
  const config = { name, description: typeof data.description === 'string' ? data.description : '', mode };
  if (typeof data.model === 'string') config.model = data.model;
  if (typeof data.temperature === 'number') config.temperature = data.temperature;
  if (typeof data.topP === 'number') config.topP = data.topP;
  if (typeof data.steps === 'number') config.steps = data.steps;
  if (typeof data.color === 'string') config.color = data.color;
  if (typeof data.variant === 'string') config.variant = data.variant;

  // Parse permission config (new format)
  if (data.permission && typeof data.permission === 'object' && !Array.isArray(data.permission)) {
    config.permission = data.permission;
  }

  // Backwards compat: parse old `tools` field into permission config
  if (!config.permission && data.tools && typeof data.tools === 'object' && !Array.isArray(data.tools)) {
    const permission = {};
    for (const [k, v] of Object.entries(data.tools)) {
      if (typeof v === 'boolean') permission[k] = v ? 'allow' : 'deny';
    }
    if (Object.keys(permission).length > 0) config.permission = permission;
  }
  const prompt = body.trim();
  if (prompt) config.prompt = prompt;
  return config;
}

function serializeAgentMarkdown(config) {
  const lines = ['---'];
  if (config.description) lines.push(`description: ${yamlScalar(config.description)}`);
  lines.push(`mode: ${config.mode}`);
  if (config.model) lines.push(`model: ${yamlScalar(config.model)}`);
  if (config.temperature !== undefined) lines.push(`temperature: ${config.temperature}`);
  if (config.topP !== undefined) lines.push(`topP: ${config.topP}`);
  if (config.steps !== undefined) lines.push(`steps: ${config.steps}`);
  if (config.color) lines.push(`color: ${yamlScalar(config.color)}`);
  if (config.variant) lines.push(`variant: ${yamlScalar(config.variant)}`);

  // Serialize permission config
  if (config.permission && Object.keys(config.permission).length > 0) {
    lines.push('permission:');
    for (const [k, v] of Object.entries(config.permission)) {
      if (typeof v === 'string') {
        lines.push(`  ${k}: ${v}`);
      } else if (typeof v === 'object') {
        lines.push(`  ${k}:`);
        for (const [pattern, action] of Object.entries(v)) {
          lines.push(`    ${pattern}: ${action}`);
        }
      }
    }
  }
  lines.push('---', '');
  if (config.prompt) lines.push(config.prompt.trim(), '');
  return lines.join('\n');
}

// ── sessionDiff helpers (from src/shared/sessionDiff.ts) ────────────────────

function stitchDoc(texts) {
  if (texts.length === 1) return texts[0];
  return texts.map((t, i) => `··· edit ${i + 1} of ${texts.length} ···\n${t}`).join('\n\n');
}

function buildSessionDiff(ops) {
  if (!ops.length) return null;
  return { before: stitchDoc(ops.map(op => op.before)), after: stitchDoc(ops.map(op => op.after)) };
}

// ── changeUtils (from src/main/history/changeUtils.ts) ──────────────────────

function countLineDiff(oldStr, newStr) {
  const oldLines = oldStr.length ? oldStr.split('\n') : [];
  const newLines = newStr.length ? newStr.split('\n') : [];
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) return { added: m, removed: n };
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return { added: m - dp[0][0], removed: n - dp[0][0] };
}

function accumulate(byPath, path, added, removed, created) {
  const rec = byPath.get(path);
  if (rec) { rec.added += added; rec.removed += removed; }
  else byPath.set(path, { added, removed, created });
}

// ── copilot pure helpers (from src/main/history/copilot.ts) ─────────────────

function replayEvents(lines) {
  let state = {};
  for (const event of lines) {
    const path = event.k ?? [];
    if (event.kind === 0 || path.length === 0) { state = event.v; continue; }
    let obj = state;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (obj[key] === undefined) obj[key] = typeof path[i + 1] === 'number' ? [] : {};
      obj = obj[key];
    }
    const lastKey = path[path.length - 1];
    if (event.kind === 2) {
      if (!Array.isArray(obj[lastKey])) obj[lastKey] = [];
      obj[lastKey].push(...event.v);
    } else {
      obj[lastKey] = event.v;
    }
  }
  return state;
}

function lineDiffForEdit(text, range) {
  const added = text === '' ? 0 : text.split('\n').length;
  const isInsertionPoint = range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
  const removed = isInsertionPoint ? 0 : range.endLineNumber - range.startLineNumber + 1;
  return { added, removed };
}

function resolveEmptyFileLinks(text) {
  return text.replace(/\[\]\((file:\/\/[^)\s]+)\)/g, (match, uri) => {
    try { return new URL(uri).pathname; } catch { return match; }
  });
}

function stripEmptyCodeFences(text) {
  return text.replace(/```[a-zA-Z]*\n\s*```/g, '');
}

function inlineReferenceLabel(item) {
  const ref = item.inlineReference;
  const name = item.name ?? ref?.name;
  if (typeof name === 'string' && name.trim()) return name;
  const fsPath = ref?.fsPath ?? ref?.location?.uri?.fsPath;
  return typeof fsPath === 'string' ? fsPath : null;
}

function accumulateChangesFromState(state) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  const byPath = new Map();
  const created = new Set();
  for (const request of requests) {
    const responseItems = Array.isArray(request?.response) ? request.response : [];
    for (const item of responseItems) {
      if (item?.kind === 'toolInvocationSerialized' && item.toolId === 'copilot_createFile') {
        for (const uri of Object.values(item.invocationMessage?.uris ?? {})) {
          if (typeof uri?.path === 'string') created.add(uri.path);
        }
      } else if (item?.kind === 'textEditGroup' && typeof item.uri?.path === 'string') {
        const path = item.uri.path;
        for (const group of item.edits ?? []) {
          for (const edit of group ?? []) {
            if (typeof edit?.text !== 'string' || !edit.range) continue;
            const diff = lineDiffForEdit(edit.text, edit.range);
            accumulate(byPath, path, diff.added, diff.removed, created.has(path));
          }
        }
      }
    }
  }
  return byPath;
}

// ── generator helpers (from src/main/agent/subagent/generator.ts) ───────────

function extractJson(text) {
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
}

function uniqueName(base, taken) {
  const root = base || 'agent';
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ── edit helpers (from src/main/tools/edit.ts) ─────────────────────────────

function countOccurrences(content, search) {
  if (search === '') return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) { count++; offset += search.length; }
  return count;
}

function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function toLineEnding(text, ending) {
  const normalized = text.replace(/\r\n/g, '\n');
  return ending === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}

// ── claudeCode pure helpers ─────────────────────────────────────────────────

function unescape(text) {
  try { return JSON.parse(`"${text}"`); } catch { return text; }
}

function truncate(text, max = 4000) {
  return text.length > max ? text.slice(0, max) + '\n… (truncated)' : text;
}

function isSyntheticUserText(text) {
  return /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)/.test(text.trim());
}

function summarizeToolClaude(name, input) {
  if (name === 'Bash' && typeof input?.command === 'string') return `Ran ${input.command}`;
  if (name === 'Read' && typeof input?.file_path === 'string') return `Read ${input.file_path}`;
  if (name === 'Write' && typeof input?.file_path === 'string') return `Wrote ${input.file_path}`;
  if (name === 'Edit' && typeof input?.file_path === 'string') return `Edited ${input.file_path}`;
  return name;
}

function summarizeToolOpencode(tool, summary) {
  if (!summary) return tool;
  if (tool === 'bash') return `Ran ${summary}`;
  if (tool === 'read') return `Read ${summary}`;
  if (tool === 'write') return `Wrote ${summary}`;
  if (tool === 'edit') return `Edited ${summary}`;
  return `${tool}: ${summary}`;
}

// ── fetch helpers (from src/main/tools/fetch.ts) ───────────────────────────

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToMarkdown(html) {
  let md = html;
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<[^>]+>/g, '');
  md = md.replace(/&nbsp;/g, ' ');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

// ── pathUtil (from src/main/tools/pathUtil.ts) ──────────────────────────────

import * as path from 'node:path';

function isExternalPath(cwd, resolvedPath) {
  const rel = path.relative(cwd, resolvedPath);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

// ── git languageFor (from src/main/git.ts) ──────────────────────────────────

const EXTENSION_LANGUAGE = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  json: 'json', css: 'css', html: 'html', md: 'markdown', py: 'python',
  rs: 'rust', go: 'go', java: 'java', sh: 'shell', txt: 'plaintext',
};

function languageFor(p) {
  const base = p.split('/').pop() ?? p;
  if (base === 'Dockerfile' || base === 'Containerfile') return 'dockerfile';
  const ext = base.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGE[ext] ?? 'plaintext';
}

// ── formatSize (from src/main/tools/ls.ts) ─────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── bash isSafeReadOnly (from src/main/tools/bash.ts) ───────────────────────

const SHELL_CHAIN_CHARS = /[;&|`\n]|\$\(/;
const SAFE_READ_ONLY = ['ls', 'pwd', 'git status', 'git log', 'git diff', 'git show'];

function isSafeReadOnly(command) {
  if (SHELL_CHAIN_CHARS.test(command)) return false;
  return SAFE_READ_ONLY.some(safe => command === safe || command.startsWith(`${safe} `));
}

// ── matchGlob (from src/main/tools/ls.ts) ──────────────────────────────────

function matchGlob(pattern, filename) {
  const regexStr = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(filename);
}

// ── estimateTokenCount (from src/main/compact/index.ts) ─────────────────────

function estimateTokenCount(messages) {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') total += Math.ceil(msg.content.length / 4);
  }
  return total;
}

// ═════════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. coerce / yamlScalar round-trip ──────────────────────────────────────

describe('coerce', () => {
  it('booleans', () => {
    assert.equal(coerce('true'), true);
    assert.equal(coerce('false'), false);
  });
  it('null', () => {
    assert.equal(coerce('null'), null);
    assert.equal(coerce('~'), null);
  });
  it('numbers', () => {
    assert.equal(coerce('42'), 42);
    assert.equal(coerce('3.14'), 3.14);
    assert.equal(coerce('0'), 0);
  });
  it('double-quoted strings', () => {
    assert.equal(coerce('"hello world"'), 'hello world');
    assert.equal(coerce('"with \\"escapes\\""'), 'with "escapes"');
  });
  it('single-quoted strings', () => {
    assert.equal(coerce("'hello'"), 'hello');
  });
  it('plain strings', () => {
    assert.equal(coerce('hello'), 'hello');
    assert.equal(coerce(''), '');
  });
});

describe('yamlScalar', () => {
  it('returns plain string when safe', () => {
    assert.equal(yamlScalar('hello'), 'hello');
    assert.equal(yamlScalar('foo-bar'), 'foo-bar');
  });
  it('quotes when contains colon', () => {
    const result = yamlScalar('http://example.com');
    assert.ok(result.startsWith('"'));
    assert.ok(result.endsWith('"'));
  });
  it('quotes when contains hash', () => {
    assert.ok(yamlScalar('foo#bar').startsWith('"'));
  });
  it('quotes when contains newline', () => {
    assert.ok(yamlScalar('foo\nbar').startsWith('"'));
  });
  it('quotes when has leading/trailing whitespace', () => {
    assert.ok(yamlScalar(' foo').startsWith('"'));
    assert.ok(yamlScalar('foo ').startsWith('"'));
  });
});

describe('yamlScalar → coerce round-trip', () => {
  it('round-trips plain strings', () => {
    const input = 'hello';
    assert.equal(coerce(yamlScalar(input)), input);
  });
  it('round-trips strings with special chars', () => {
    const input = 'http://example.com:8080/path?q=1#hash';
    assert.equal(coerce(yamlScalar(input)), input);
  });
  it('round-trips strings with colons', () => {
    const input = 'key: value';
    assert.equal(coerce(yamlScalar(input)), input);
  });
  it('round-trips strings with newlines', () => {
    const input = 'line1\nline2';
    assert.equal(coerce(yamlScalar(input)), input);
  });
  it('round-trips empty string', () => {
    const input = '';
    assert.equal(coerce(yamlScalar(input)), input);
  });
});

// ── 2. parseYamlish / splitFrontmatter ─────────────────────────────────────

describe('parseYamlish', () => {
  it('parses flat scalars', () => {
    const result = parseYamlish('name: test\ndescription: a test\nmode: subagent');
    assert.equal(result.name, 'test');
    assert.equal(result.description, 'a test');
    assert.equal(result.mode, 'subagent');
  });
  it('parses nested maps', () => {
    const result = parseYamlish('tools:\n  read: true\n  write: false');
    assert.deepEqual(result.tools, { read: true, write: false });
  });
  it('parses booleans and numbers', () => {
    const result = parseYamlish('flag: true\ncount: 42\ntemp: 0.5');
    assert.equal(result.flag, true);
    assert.equal(result.count, 42);
    assert.equal(result.temp, 0.5);
  });
  it('skips comments and blank lines', () => {
    const result = parseYamlish('# comment\n\nname: ok\n  # indented comment\n');
    assert.equal(result.name, 'ok');
  });
  it('handles empty input', () => {
    assert.deepEqual(parseYamlish(''), {});
  });
});

describe('splitFrontmatter', () => {
  it('splits valid frontmatter', () => {
    const text = '---\nname: test\nmode: subagent\n---\n\nBody here';
    const { data, body } = splitFrontmatter(text);
    assert.equal(data.name, 'test');
    assert.equal(data.mode, 'subagent');
    // splitFrontmatter keeps the leading newline after ---; consumers trim()
    assert.ok(body.includes('Body here'));
  });
  it('returns full text as body when no frontmatter', () => {
    const { data, body } = splitFrontmatter('Just plain text');
    assert.deepEqual(data, {});
    assert.equal(body, 'Just plain text');
  });
  it('returns data {} when opening --- but no closing ---', () => {
    const { data, body } = splitFrontmatter('---\nname: test');
    assert.deepEqual(data, {});
  });
  it('normalizes CRLF', () => {
    const text = '---\r\nname: test\r\n---\r\n\r\nBody';
    const { data, body } = splitFrontmatter(text);
    assert.equal(data.name, 'test');
    assert.ok(body.includes('Body'));
  });
});

// ── 3. parseAgentMarkdown / serializeAgentMarkdown round-trip ───────────────

describe('serializeAgentMarkdown → parseAgentMarkdown round-trip', () => {
  it('minimal config', () => {
    const config = { name: 'test', description: 'A test agent', mode: 'subagent' };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('test', md);
    assert.equal(parsed.name, 'test');
    assert.equal(parsed.description, 'A test agent');
    assert.equal(parsed.mode, 'subagent');
  });

  it('config with model and temperature', () => {
    const config = { name: 'test', description: 'desc', mode: 'primary', model: 'gpt-4o', temperature: 0.3 };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('test', md);
    assert.equal(parsed.model, 'gpt-4o');
    assert.equal(parsed.temperature, 0.3);
    assert.equal(parsed.mode, 'primary');
  });

  it('config with permission', () => {
    const config = {
      name: 'test', description: 'desc', mode: 'subagent',
      permission: { read: 'allow', write: 'deny', edit: 'deny' },
    };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('test', md);
    assert.deepEqual(parsed.permission, { read: 'allow', write: 'deny', edit: 'deny' });
  });

  it('config with prompt', () => {
    const config = { name: 'test', description: 'desc', mode: 'subagent', prompt: 'You are a helpful assistant.' };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('test', md);
    assert.equal(parsed.prompt, 'You are a helpful assistant.');
  });

  it('full config round-trip', () => {
    const config = {
      name: 'my-agent',
      description: 'Does everything',
      mode: 'all',
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      topP: 0.9,
      steps: 30,
      color: '#ff0000',
      permission: { write: 'deny', edit: { '*.test.ts': 'allow', '*': 'deny' } },
      prompt: 'You are an expert.\nWith multiple lines.',
    };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('my-agent', md);
    assert.equal(parsed.name, 'my-agent');
    assert.equal(parsed.description, 'Does everything');
    assert.equal(parsed.mode, 'all');
    assert.equal(parsed.model, 'claude-sonnet-4-20250514');
    assert.equal(parsed.temperature, 0.7);
    assert.equal(parsed.topP, 0.9);
    assert.equal(parsed.steps, 30);
    assert.equal(parsed.color, '#ff0000');
    assert.deepEqual(parsed.permission, { write: 'deny', edit: { '*.test.ts': 'allow', '*': 'deny' } });
    assert.equal(parsed.prompt, 'You are an expert.\nWith multiple lines.');
  });

  it('description with special YAML chars', () => {
    const config = { name: 'test', description: 'Uses key: value pairs & more!', mode: 'subagent' };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('test', md);
    assert.equal(parsed.description, 'Uses key: value pairs & more!');
  });

  it('description with newlines', () => {
    const config = { name: 'test', description: 'Line1\nLine2', mode: 'subagent' };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('test', md);
    assert.equal(parsed.description, 'Line1\nLine2');
  });

  it('empty optional fields are omitted', () => {
    const config = { name: 'test', description: 'desc', mode: 'subagent' };
    const md = serializeAgentMarkdown(config);
    assert.ok(!md.includes('model:'));
    assert.ok(!md.includes('temperature:'));
    assert.ok(!md.includes('topP:'));
    assert.ok(!md.includes('steps:'));
    assert.ok(!md.includes('color:'));
    assert.ok(!md.includes('permission:'));
    assert.ok(!md.includes('prompt:'));
  });

  it('defaults mode to subagent on parse when missing', () => {
    const md = '---\ndescription: test\n---\n';
    const parsed = parseAgentMarkdown('test', md);
    assert.equal(parsed.mode, 'subagent');
  });

  it('handles "all" mode', () => {
    const config = { name: 'test', description: 'desc', mode: 'all' };
    const md = serializeAgentMarkdown(config);
    const parsed = parseAgentMarkdown('test', md);
    assert.equal(parsed.mode, 'all');
  });

  it('backwards compat: old tools field converts to permission', () => {
    const md = '---\ndescription: test\nmode: subagent\ntools:\n  read: true\n  write: false\n  bash: false\n---\n';
    const parsed = parseAgentMarkdown('test', md);
    assert.deepEqual(parsed.permission, { read: 'allow', write: 'deny', bash: 'deny' });
  });

  it('new permission field takes precedence over old tools', () => {
    const md = '---\ndescription: test\nmode: subagent\npermission:\n  read: allow\n  edit: deny\ntools:\n  write: false\n---\n';
    const parsed = parseAgentMarkdown('test', md);
    assert.deepEqual(parsed.permission, { read: 'allow', edit: 'deny' });
  });
});

// ── 4. stitchDoc / buildSessionDiff ─────────────────────────────────────────

describe('stitchDoc', () => {
  it('returns single text as-is', () => {
    assert.equal(stitchDoc(['hello']), 'hello');
  });
  it('joins multiple texts with headers', () => {
    const result = stitchDoc(['aaa', 'bbb', 'ccc']);
    assert.ok(result.includes('··· edit 1 of 3 ···'));
    assert.ok(result.includes('··· edit 2 of 3 ···'));
    assert.ok(result.includes('··· edit 3 of 3 ···'));
    assert.ok(result.startsWith('··· edit 1 of 3 ···\naaa'));
  });
  it('round-trip: headers are symmetric', () => {
    const ops = [{ before: 'old1', after: 'new1' }, { before: 'old2', after: 'new2' }];
    const diff = buildSessionDiff(ops);
    const beforeHeaders = diff.before.match(/··· edit \d+ of \d+ ···/g);
    const afterHeaders = diff.after.match(/··· edit \d+ of \d+ ···/g);
    assert.deepEqual(beforeHeaders, afterHeaders);
  });
});

describe('buildSessionDiff', () => {
  it('returns null for empty ops', () => {
    assert.equal(buildSessionDiff([]), null);
  });
  it('builds before/after from ops', () => {
    const ops = [{ before: 'old', after: 'new' }];
    const diff = buildSessionDiff(ops);
    assert.equal(diff.before, 'old');
    assert.equal(diff.after, 'new');
  });
});

// ── 5. countLineDiff ───────────────────────────────────────────────────────

describe('countLineDiff', () => {
  it('identical strings', () => {
    assert.deepEqual(countLineDiff('a\nb', 'a\nb'), { added: 0, removed: 0 });
  });
  it('added lines', () => {
    assert.deepEqual(countLineDiff('a', 'a\nb\n'), { added: 2, removed: 0 });
  });
  it('removed lines', () => {
    assert.deepEqual(countLineDiff('a\nb', 'a'), { added: 0, removed: 1 });
  });
  it('mixed changes', () => {
    assert.deepEqual(countLineDiff('a\nb\nc', 'a\nd\nc'), { added: 1, removed: 1 });
  });
  it('empty old', () => {
    assert.deepEqual(countLineDiff('', 'a\nb'), { added: 2, removed: 0 });
  });
  it('empty new', () => {
    assert.deepEqual(countLineDiff('a\nb', ''), { added: 0, removed: 2 });
  });
  it('both empty', () => {
    assert.deepEqual(countLineDiff('', ''), { added: 0, removed: 0 });
  });
  it('single line change', () => {
    assert.deepEqual(countLineDiff('hello', 'world'), { added: 1, removed: 1 });
  });
});

// ── 6. accumulate ──────────────────────────────────────────────────────────

describe('accumulate', () => {
  it('creates new entry', () => {
    const m = new Map();
    accumulate(m, 'file.ts', 5, 3, true);
    assert.deepEqual(m.get('file.ts'), { added: 5, removed: 3, created: true });
  });
  it('merges existing entry', () => {
    const m = new Map();
    accumulate(m, 'file.ts', 5, 3, true);
    accumulate(m, 'file.ts', 2, 1, false);
    assert.deepEqual(m.get('file.ts'), { added: 7, removed: 4, created: true });
  });
});

// ── 7. replayEvents ────────────────────────────────────────────────────────

describe('replayEvents', () => {
  it('kind 0 sets entire state', () => {
    const result = replayEvents([{ kind: 0, v: { a: 1 } }]);
    assert.deepEqual(result, { a: 1 });
  });
  it('kind 1 sets value at path', () => {
    const result = replayEvents([
      { kind: 0, v: {} },
      { kind: 1, k: ['foo'], v: 'bar' },
    ]);
    assert.equal(result.foo, 'bar');
  });
  it('kind 2 appends to array', () => {
    const result = replayEvents([
      { kind: 0, v: {} },
      { kind: 1, k: ['items'], v: [1] },
      { kind: 2, k: ['items'], v: [2, 3] },
    ]);
    assert.deepEqual(result.items, [1, 2, 3]);
  });
  it('creates intermediate objects', () => {
    const result = replayEvents([
      { kind: 0, v: {} },
      { kind: 1, k: ['a', 'b', 'c'], v: 42 },
    ]);
    assert.equal(result.a.b.c, 42);
  });
  it('empty path sets entire state', () => {
    const result = replayEvents([{ kind: 1, k: [], v: { x: 1 } }]);
    assert.deepEqual(result, { x: 1 });
  });
});

// ── 8. lineDiffForEdit ─────────────────────────────────────────────────────

describe('lineDiffForEdit', () => {
  it('insertion point (0 removed)', () => {
    const r = lineDiffForEdit('new line', { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 1 });
    assert.equal(r.added, 1);
    assert.equal(r.removed, 0);
  });
  it('replacement', () => {
    const r = lineDiffForEdit('a\nb', { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 5 });
    assert.equal(r.added, 2);
    assert.equal(r.removed, 2);
  });
  it('empty text', () => {
    const r = lineDiffForEdit('', { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });
    assert.equal(r.added, 0);
    assert.equal(r.removed, 0);
  });
});

// ── 9. Copilot pure helpers ────────────────────────────────────────────────

describe('resolveEmptyFileLinks', () => {
  it('replaces empty-label file links', () => {
    const result = resolveEmptyFileLinks('Read [](file:///path/to/file.ts)');
    assert.ok(result.includes('/path/to/file.ts'));
    assert.ok(!result.includes('[]('));
  });
  it('leaves non-empty links alone', () => {
    const input = '[label](file:///path/to/file.ts)';
    assert.equal(resolveEmptyFileLinks(input), input);
  });
});

describe('stripEmptyCodeFences', () => {
  it('removes empty code fences', () => {
    assert.equal(stripEmptyCodeFences('```ts\n```'), '');
  });
  it('leaves non-empty fences alone', () => {
    const input = '```ts\nconst x = 1;\n```';
    assert.equal(stripEmptyCodeFences(input), input);
  });
  it('handles mixed content', () => {
    const input = 'text ```ts\n``` more';
    assert.equal(stripEmptyCodeFences(input), 'text  more');
  });
});

describe('inlineReferenceLabel', () => {
  it('prefers item.name', () => {
    assert.equal(inlineReferenceLabel({ name: 'Foo' }), 'Foo');
  });
  it('falls back to inlineReference.name', () => {
    assert.equal(inlineReferenceLabel({ inlineReference: { name: 'Bar' } }), 'Bar');
  });
  it('falls back to fsPath', () => {
    assert.equal(inlineReferenceLabel({ inlineReference: { fsPath: '/a/b.ts' } }), '/a/b.ts');
  });
  it('returns null when nothing available', () => {
    assert.equal(inlineReferenceLabel({ inlineReference: {} }), null);
  });
});

describe('accumulateChangesFromState', () => {
  it('accumulates textEditGroup changes', () => {
    const state = {
      requests: [{
        response: [
          { kind: 'textEditGroup', uri: { path: '/file.ts' }, edits: [[{ text: 'a\nb', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }]] },
        ],
      }],
    };
    const result = accumulateChangesFromState(state);
    assert.equal(result.get('/file.ts').added, 2);
  });
  it('marks copilot_createFile as created', () => {
    const state = {
      requests: [{
        response: [
          { kind: 'toolInvocationSerialized', toolId: 'copilot_createFile', invocationMessage: { uris: { 0: { path: '/new.ts' } } } },
          { kind: 'textEditGroup', uri: { path: '/new.ts' }, edits: [[{ text: 'content', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } }]] },
        ],
      }],
    };
    const result = accumulateChangesFromState(state);
    assert.equal(result.get('/new.ts').created, true);
  });
});

// ── 10. extractJson / sanitizeName / uniqueName ────────────────────────────

describe('extractJson', () => {
  it('extracts bare JSON', () => {
    const result = extractJson('{"name": "test"}');
    assert.deepEqual(result, { name: 'test' });
  });
  it('extracts from markdown fences', () => {
    const result = extractJson('```json\n{"name": "test"}\n```');
    assert.deepEqual(result, { name: 'test' });
  });
  it('extracts from prose', () => {
    const result = extractJson('Here is the config:\n{"name": "test"}\nDone.');
    assert.deepEqual(result, { name: 'test' });
  });
  it('returns null for non-JSON', () => {
    assert.equal(extractJson('no json here'), null);
  });
  it('returns null for arrays', () => {
    assert.equal(extractJson('[1,2,3]'), null);
  });
});

describe('sanitizeName', () => {
  it('lowercases and hyphenates', () => {
    assert.equal(sanitizeName('My Agent Name'), 'my-agent-name');
  });
  it('strips non-alphanumeric', () => {
    assert.equal(sanitizeName('hello!@#world'), 'hello-world');
  });
  it('truncates to 30 chars', () => {
    const long = 'a'.repeat(50);
    assert.equal(sanitizeName(long).length, 30);
  });
  it('returns empty for non-string', () => {
    assert.equal(sanitizeName(42), '');
  });
});

describe('uniqueName', () => {
  it('returns base if not taken', () => {
    assert.equal(uniqueName('foo', new Set()), 'foo');
  });
  it('appends suffix when taken', () => {
    assert.equal(uniqueName('foo', new Set(['foo'])), 'foo-2');
  });
  it('finds first free slot', () => {
    assert.equal(uniqueName('foo', new Set(['foo', 'foo-2'])), 'foo-3');
  });
  it('defaults to agent when empty', () => {
    assert.equal(uniqueName('', new Set()), 'agent');
  });
});

// ── 11. edit helpers ───────────────────────────────────────────────────────

describe('countOccurrences', () => {
  it('counts non-overlapping matches', () => {
    assert.equal(countOccurrences('aaa', 'aa'), 1);
    assert.equal(countOccurrences('ababab', 'ab'), 3);
  });
  it('returns 0 for empty search', () => {
    assert.equal(countOccurrences('abc', ''), 0);
  });
  it('returns 0 when not found', () => {
    assert.equal(countOccurrences('abc', 'xyz'), 0);
  });
});

describe('detectLineEnding', () => {
  it('detects CRLF', () => {
    assert.equal(detectLineEnding('a\r\nb'), '\r\n');
  });
  it('detects LF', () => {
    assert.equal(detectLineEnding('a\nb'), '\n');
  });
  it('defaults to LF for no newlines', () => {
    assert.equal(detectLineEnding('abc'), '\n');
  });
});

describe('toLineEnding', () => {
  it('normalizes to LF', () => {
    assert.equal(toLineEnding('a\r\nb\r\n', '\n'), 'a\nb\n');
  });
  it('converts to CRLF', () => {
    assert.equal(toLineEnding('a\nb\n', '\r\n'), 'a\r\nb\r\n');
  });
});

describe('detectLineEnding ↔ toLineEnding round-trip', () => {
  it('preserves CRLF', () => {
    const input = 'line1\r\nline2\r\n';
    const ending = detectLineEnding(input);
    const normalized = toLineEnding(input, '\n');
    const restored = toLineEnding(normalized, ending);
    assert.equal(restored, input);
  });
  it('preserves LF', () => {
    const input = 'line1\nline2\n';
    const ending = detectLineEnding(input);
    const normalized = toLineEnding(input, '\n');
    const restored = toLineEnding(normalized, ending);
    assert.equal(restored, input);
  });
});

// ── 12. claudeCode pure helpers ─────────────────────────────────────────────

describe('unescape', () => {
  it('unescapes JSON string', () => {
    assert.equal(unescape('hello\\nworld'), 'hello\nworld');
  });
  it('unescapes quotes', () => {
    assert.equal(unescape('say \\"hi\\"'), 'say "hi"');
  });
  it('returns original on failure', () => {
    assert.equal(unescape('no-escape'), 'no-escape');
  });
});

describe('truncate', () => {
  it('returns short text as-is', () => {
    assert.equal(truncate('short'), 'short');
  });
  it('truncates long text', () => {
    const long = 'x'.repeat(5000);
    const result = truncate(long);
    assert.equal(result.length, 4000 + '\n… (truncated)'.length);
    assert.ok(result.endsWith('… (truncated)'));
  });
});

describe('isSyntheticUserText', () => {
  it('detects command-name', () => {
    assert.equal(isSyntheticUserText('<command-name>/foo</command-name>'), true);
  });
  it('detects local-command-stdout', () => {
    assert.equal(isSyntheticUserText('<local-command-stdout>output</local-command-stdout>'), true);
  });
  it('rejects normal text', () => {
    assert.equal(isSyntheticUserText('Hello, world!'), false);
  });
});

describe('summarizeToolClaude', () => {
  it('Bash command', () => {
    assert.equal(summarizeToolClaude('Bash', { command: 'npm test' }), 'Ran npm test');
  });
  it('Read file', () => {
    assert.equal(summarizeToolClaude('Read', { file_path: '/a.ts' }), 'Read /a.ts');
  });
  it('Write file', () => {
    assert.equal(summarizeToolClaude('Write', { file_path: '/a.ts' }), 'Wrote /a.ts');
  });
  it('Edit file', () => {
    assert.equal(summarizeToolClaude('Edit', { file_path: '/a.ts' }), 'Edited /a.ts');
  });
  it('unknown tool returns name', () => {
    assert.equal(summarizeToolClaude('Foo', {}), 'Foo');
  });
});

describe('summarizeToolOpencode', () => {
  it('bash', () => {
    assert.equal(summarizeToolOpencode('bash', 'npm test'), 'Ran npm test');
  });
  it('read', () => {
    assert.equal(summarizeToolOpencode('read', '/a.ts'), 'Read /a.ts');
  });
  it('empty summary', () => {
    assert.equal(summarizeToolOpencode('edit', ''), 'edit');
  });
  it('unknown tool', () => {
    assert.equal(summarizeToolOpencode('foo', 'bar'), 'foo: bar');
  });
});

// ── 13. fetch helpers ──────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('strips tags', () => {
    assert.equal(stripHtml('<p>Hello <b>world</b></p>'), 'Hello world');
  });
  it('removes script/style', () => {
    const html = '<p>text</p><script>alert(1)</script><style>.x{}</style>';
    assert.equal(stripHtml(html), 'text');
  });
  it('collapses whitespace', () => {
    assert.equal(stripHtml('a  \n  b'), 'a b');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings', () => {
    assert.ok(htmlToMarkdown('<h1>Title</h1>').includes('# Title'));
    assert.ok(htmlToMarkdown('<h2>Sub</h2>').includes('## Sub'));
  });
  it('converts links', () => {
    assert.ok(htmlToMarkdown('<a href="http://x">click</a>').includes('[click](http://x)'));
  });
  it('converts code', () => {
    assert.ok(htmlToMarkdown('<code>x</code>').includes('`x`'));
  });
  it('converts pre', () => {
    assert.ok(htmlToMarkdown('<pre>code</pre>').includes('```\ncode\n```'));
  });
  it('converts list items', () => {
    assert.ok(htmlToMarkdown('<li>item</li>').includes('- item'));
  });
  it('removes script/style blocks', () => {
    const html = '<p>ok</p><script>x</script>';
    assert.equal(htmlToMarkdown(html), 'ok');
  });
  it('handles br', () => {
    assert.ok(htmlToMarkdown('a<br>b').includes('a\nb'));
  });
  it('decodes entities', () => {
    assert.ok(htmlToMarkdown('&amp;').includes('&'));
    assert.ok(htmlToMarkdown('&lt;').includes('<'));
    assert.ok(htmlToMarkdown('&gt;').includes('>'));
  });
});

// ── 14. pathUtil ───────────────────────────────────────────────────────────

describe('isExternalPath', () => {
  it('detects external path', () => {
    assert.equal(isExternalPath('/project', '/other/file.ts'), true);
  });
  it('detects internal path', () => {
    assert.equal(isExternalPath('/project', '/project/src/file.ts'), false);
  });
  it('detects parent traversal', () => {
    assert.equal(isExternalPath('/project', path.join('/project', '..', 'secret.ts')), true);
  });
});

// ── 15. languageFor ────────────────────────────────────────────────────────

describe('languageFor', () => {
  it('maps extensions', () => {
    assert.equal(languageFor('file.ts'), 'typescript');
    assert.equal(languageFor('file.py'), 'python');
    assert.equal(languageFor('file.rs'), 'rust');
    assert.equal(languageFor('file.go'), 'go');
  });
  it('Dockerfile special case', () => {
    assert.equal(languageFor('Dockerfile'), 'dockerfile');
  });
  it('unknown extension returns plaintext', () => {
    assert.equal(languageFor('file.xyz'), 'plaintext');
  });
});

// ── 16. formatSize ─────────────────────────────────────────────────────────

describe('formatSize', () => {
  it('bytes', () => assert.equal(formatSize(500), '500B'));
  it('KB', () => assert.equal(formatSize(1536), '1.5KB'));
  it('MB', () => assert.equal(formatSize(2 * 1024 * 1024), '2.0MB'));
  it('zero', () => assert.equal(formatSize(0), '0B'));
});

// ── 17. isSafeReadOnly ─────────────────────────────────────────────────────

describe('isSafeReadOnly', () => {
  it('allows safe commands', () => {
    assert.equal(isSafeReadOnly('ls'), true);
    assert.equal(isSafeReadOnly('ls -la'), true);
    assert.equal(isSafeReadOnly('pwd'), true);
    assert.equal(isSafeReadOnly('git status'), true);
    assert.equal(isSafeReadOnly('git log --oneline'), true);
    assert.equal(isSafeReadOnly('git diff HEAD'), true);
  });
  it('rejects unsafe commands', () => {
    assert.equal(isSafeReadOnly('rm -rf /'), false);
    assert.equal(isSafeReadOnly('curl http://x'), false);
  });
  it('rejects chaining', () => {
    assert.equal(isSafeReadOnly('ls; rm -rf /'), false);
    assert.equal(isSafeReadOnly('ls && rm -rf /'), false);
    assert.equal(isSafeReadOnly('ls | rm'), false);
  });
});

// ── 18. matchGlob ──────────────────────────────────────────────────────────

describe('matchGlob', () => {
  it('matches exact', () => assert.equal(matchGlob('foo.ts', 'foo.ts'), true));
  it('matches wildcard', () => assert.equal(matchGlob('*.ts', 'foo.ts'), true));
  it('matches question mark', () => assert.equal(matchGlob('?.ts', 'a.ts'), true));
  it('rejects non-match', () => assert.equal(matchGlob('*.ts', 'foo.js'), false));
  it('matches dot files', () => assert.equal(matchGlob('.*', '.gitignore'), true));
});

// ── 19. estimateTokenCount ─────────────────────────────────────────────────

describe('estimateTokenCount', () => {
  it('estimates tokens', () => {
    const msgs = [{ role: 'user', content: 'a'.repeat(100) }];
    assert.equal(estimateTokenCount(msgs), 25); // ceil(100/4)
  });
  it('skips non-string content', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    assert.equal(estimateTokenCount(msgs), 0);
  });
  it('sums multiple messages', () => {
    const msgs = [
      { role: 'user', content: 'a'.repeat(8) },
      { role: 'assistant', content: 'b'.repeat(12) },
    ];
    assert.equal(estimateTokenCount(msgs), 5); // 2 + 3
  });
});
