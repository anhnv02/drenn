import { execFile } from 'node:child_process';
import { promises as fs } from 'fs';
import { homedir, release, type as osType } from 'os';
import { join } from 'path';
import { getAgent, getProjectAgentsPromptSection } from './subagent';
import { getCachedMemory, projectMemoryDir } from './memoryStore';
import { getSkillPromptSection } from '../skills';

const GLOBAL_INSTRUCTIONS_FILE = join(homedir(), '.config', 'drenn', 'AGENTS.md');
const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'];
const INSTRUCTIONS_TTL_MS = 15_000;
const MAX_INSTRUCTIONS_LENGTH = 24_000;

const instructionsCache = new Map<string, { content: string; loadedAt: number }>();

async function readInstructionFile(filePath: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(filePath, 'utf8')).trim();
    if (!text) return null;
    return text.length > MAX_INSTRUCTIONS_LENGTH
      ? text.slice(0, MAX_INSTRUCTIONS_LENGTH) + '\n... [truncated]'
      : text;
  } catch {
    return null;
  }
}

export async function loadProjectInstructions(cwd: string): Promise<string> {
  const cached = instructionsCache.get(cwd);
  if (cached && Date.now() - cached.loadedAt < INSTRUCTIONS_TTL_MS) {
    return cached.content;
  }

  const sections: string[] = [];
  const globalText = await readInstructionFile(GLOBAL_INSTRUCTIONS_FILE);
  if (globalText) {
    sections.push(
      `Contents of ${GLOBAL_INSTRUCTIONS_FILE} (user's global instructions for all projects):\n\n${globalText}`,
    );
  }
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const filePath = join(cwd, name);
    const text = await readInstructionFile(filePath);
    if (text) {
      sections.push(
        `Contents of ${filePath} (project instructions, checked into the codebase):\n\n${text}`,
      );
    }
  }

  const content = sections.join('\n\n');
  instructionsCache.set(cwd, { content, loadedAt: Date.now() });
  return content;
}

function getCachedInstructions(cwd: string): string {
  return instructionsCache.get(cwd)?.content ?? '';
}

interface GitContext {
  isRepo: boolean;
  snapshot: string;
}

const gitContextCache = new Map<string, { context: GitContext; loadedAt: number }>();
const GIT_STATUS_MAX_LINES = 40;
const GIT_CMD_TIMEOUT_MS = 3_000;

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_CMD_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? null : stdout.trim());
      },
    );
  });
}

async function detectMainBranch(cwd: string): Promise<string> {
  const originHead = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (originHead) return originHead.replace(/^origin\//, '');
  if ((await git(['rev-parse', '--verify', '--quiet', 'main'], cwd)) !== null) return 'main';
  return 'master';
}

export async function loadGitContext(cwd: string): Promise<GitContext> {
  const cached = gitContextCache.get(cwd);
  if (cached && Date.now() - cached.loadedAt < INSTRUCTIONS_TTL_MS) {
    return cached.context;
  }

  let context: GitContext;
  const inRepo = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inRepo !== 'true') {
    context = { isRepo: false, snapshot: '' };
  } else {
    const [branch, mainBranch, status, log] = await Promise.all([
      git(['branch', '--show-current'], cwd),
      detectMainBranch(cwd),
      git(['status', '--porcelain'], cwd),
      git(['log', '--oneline', '-5'], cwd),
    ]);

    let statusText: string;
    if (!status) {
      statusText = '(clean)';
    } else {
      const lines = status.split('\n');
      statusText =
        lines.length > GIT_STATUS_MAX_LINES
          ? lines.slice(0, GIT_STATUS_MAX_LINES).join('\n') +
            `\n... (+${lines.length - GIT_STATUS_MAX_LINES} more)`
          : status;
    }

    context = {
      isRepo: true,
      snapshot: `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

Current branch: ${branch || '(detached HEAD)'}

Main branch (you will usually use this for PRs): ${mainBranch}

Status:
${statusText}

Recent commits:
${log || '(no commits)'}`,
    };
  }

  gitContextCache.set(cwd, { context, loadedAt: Date.now() });
  return context;
}

function getCachedGitContext(cwd: string): GitContext {
  return gitContextCache.get(cwd)?.context ?? { isRepo: false, snapshot: '' };
}

export function buildSystemPrompt(cwd: string, agentName?: string, summary?: string): string {
  const platformName =
    process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const gitContext = getCachedGitContext(cwd);

  let agentPrompt = '';
  if (agentName) {
    const agent = getAgent(agentName, cwd);
    if (agent?.config.prompt) {
      agentPrompt = `\n\n# Agent-specific instructions\n${agent.config.prompt}`;
    }
  }

  const gitStatusSection = gitContext.isRepo ? `\n\n# gitStatus\n${gitContext.snapshot}` : '';

  const projectAgents = getProjectAgentsPromptSection(cwd);
  const projectAgentsSection = projectAgents ? `\n\n# Project sub-agents\n${projectAgents}` : '';

  const instructions = getCachedInstructions(cwd);
  const instructionsSection = instructions
    ? `\n\n# Project and user instructions\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n${instructions}`
    : '';

  const memory = getCachedMemory(cwd);
  const memorySection = memory
    ? `\n\n# Project memory\nThis is your memory index for this project (MEMORY.md), carried over from earlier sessions. Read a linked topic file with view/grep when you need the detail behind an entry.\n\n${memory}`
    : '';

  const skillSection = getSkillPromptSection(cwd);

  const summarySection = summary
    ? `\n\n# Previous conversation summary\nThis session is being continued from a conversation that ran out of context. The summary below covers the earlier turns; continue the work from where it left off.\n\n${summary}`
    : '';

  return `You are an interactive coding agent that helps users with software engineering tasks, working inside the user's project. Use the instructions below and the tools available to you to assist the user.

# Tone and style
- Be concise, direct, and to the point. Your output is rendered as markdown in a chat panel.
- Answer the user's question directly, without preamble ("Here's what I'll do...") or postamble ("Let me know if..."). Lead with what you did or found; skip restating the request. One-word answers are best when they suffice.
- When you run a non-trivial command or take a significant action, say briefly what you're doing and why.
- Only use emoji if the user explicitly asks for it.
- When referencing code, use the pattern \`file_path:line_number\` so the user can jump to the location.

# Proactiveness
- Do the right thing when asked, including reasonable directly-implied follow-up actions — but don't surprise the user with actions beyond the scope of the request.
- If the user asks how to approach something or asks a question, answer it first; do not immediately jump into edits.
- After finishing a task, stop; briefly report what you did rather than explaining further steps you could take.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume a library is available, even a well-known one. Before using one, check that this codebase already uses it (package.json / imports in neighboring files).
- When you create a new component or module, look at an existing one first and follow its conventions (naming, structure, typing, framework choice).
- DO NOT ADD COMMENTS to the code you write unless the user asks for them or the code is genuinely non-obvious.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets to the repository.

# Task management
Use the todowrite tool (when available) for multi-step or non-trivial tasks: plan the steps up front, mark each one in_progress before starting it and completed immediately after finishing it, and keep exactly one task in_progress at a time. Skip it for single, trivial steps.

# Memory
You have a persistent per-project memory at ${projectMemoryDir(cwd)} (index MEMORY.md plus one topic file per subject) — use the memory tool (when available) to read and write it; it survives across sessions and is invisible to the user.
Save durable, hard-to-rederive things: explicit user preferences/corrections ("always use pnpm here", "never touch legacy/"), non-obvious project quirks or workarounds you had to discover the hard way, and stable facts the user tells you that aren't already written down. Do NOT save things you can cheaply rediscover by reading the code or running git — file layout, dependency versions, current diffs, commit history. Prefer updating an existing topic file over creating a near-duplicate one; keep MEMORY.md itself to short one-line pointers, since the full index loads into your context every session. Save proactively as you learn things worth remembering — don't wait to be asked.

# Doing tasks
1. Understand before editing: use grep/glob/view to explore the codebase. For open-ended searches that may take several rounds, delegate to the task tool instead of searching turn by turn.
2. Implement with edit/write/apply_patch. Use view before editing a file; edit requires old_string to match the file content exactly, including whitespace. Prefer edit for changing existing files; use write only to create new files or fully rewrite one.
3. Verify your changes when practical: if the project has tests, run them; otherwise run a build or type-check. NEVER assume a specific test framework or script — check the README or package.json for the right command.
4. NEVER commit changes unless the user explicitly asks you to.

# Tool usage policy
- When multiple independent tool calls are needed, batch them in a single response — they run in parallel (e.g. several view/grep calls at once).
- Prefer the dedicated tools over bash equivalents: grep over \`grep\`/\`rg\`, glob over \`find\`, view over \`cat\`, ls over shell \`ls\`.
- After grep/glob finds the file you need, act on it directly instead of re-searching.
- All relative paths resolve against the working directory below. Never guess absolute paths like /workspace or /root — use the working directory.
- Use shell commands appropriate for ${platformName} (BSD userland on macOS: e.g. no GNU-only flags like cat -A). For long-running commands, use bash with run_in_background and poll with bash_output.
- If a genuine decision needs the user's input, use the question tool; otherwise proceed with the reasonable default instead of asking.

# Environment
Working directory: ${cwd}
Is directory a git repo: ${gitContext.isRepo ? 'Yes' : 'No'}
Platform: ${platformName} (${process.platform})
OS version: ${osType()} ${release()}
Today's date: ${new Date().toISOString().slice(0, 10)}${gitStatusSection}${agentPrompt}${projectAgentsSection}${skillSection}${instructionsSection}${memorySection}${summarySection}`;
}
