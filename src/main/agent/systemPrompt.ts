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

const MEMORY_TYPES = `## Memory Types

There are four types of memory you can store. Each has a scope:

- **user** (always private) — The user's role, expertise level, and working preferences. Helps you tailor how you collaborate. For example: "The user is a data scientist new to frontend" or "The user prefers brief answers."
- **feedback** (usually private) — Guidance the user has given about your approach. Both corrections ("no, don't do that") and confirmations ("yes exactly, keep doing that"). Record *why* so you can judge edge cases later.
- **project** (team or private) — Ongoing work, deadlines, decisions, and context not derivable from code or git. Help you understand the "why" behind the work.
- **reference** (usually team) — Pointers to where information lives in external systems (issue trackers, dashboards, Slack channels).

## Citing Memory

When you use or reference memory content in your reply to the user, wrap the relevant sentence in a tag:

<drenn-memory filenames="topic-file.md">The verified test command for this project is bun test</drenn-memory>

Do this in your reply text — never inside tool inputs such as plans or todo items.

## When to Save

Save a memory when:
- The user corrects your approach ("no not that", "stop doing X") or confirms a non-obvious choice
- You learn details about the user's role, preferences, or expertise
- You discover non-obvious project quirks that took effort to find
- The user tells you about ongoing work, deadlines, or decisions

Save proactively as you learn — don't wait to be asked. Update or remove memories that become stale.

## What NOT to Save

Never save these to memory:
- Code patterns, conventions, file paths, or architecture (read from code instead)
- Git history or recent changes (use \`git log\` / \`git blame\` — they are authoritative)
- Debugging solutions or fix recipes (the fix is in the code)
- Anything already documented in CLAUDE.md files (the markdown, not the path)
- Ephemeral task details or in-progress work

Even if the user asks you to save something in this list, explain why you're not saving it and ask what was *surprising* or *non-obvious* instead.

## Before Acting on Memory

Memory records can become stale. Before answering or building assumptions from memory:
- If it names a file path: check the file still exists
- If it names a function or flag: grep for it
- If the user is about to act on your recommendation: verify first

"The memory says X exists" is not the same as "X exists now."

## Memory and Other Persistence

- **Plan** — Use when you need to align on approach before starting non-trivial work
- **Tasks** — Use for discrete steps within current work (track progress, not context)
- **Memory** — For facts that survive across future conversations

## Project Skill Upkeep

When you save a feedback memory about how you ran a repeatable step — how you verified, committed, opened a PR, or used a project skill — fold the same correction into the project skill that drives that step (\`.drenn/skills/<name>/SKILL.md\`): a terse, general edit so the next session gets it right unprompted.

Edit existing skill files only; never create one. Each correction lives in exactly one skill file: the closest-scoped one, never duplicated at broader scopes.`;

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
    ? `\n\n# Project and user instructions\nCodebase and user instructions are shown below. Adhere to these exactly — they override default behavior.\n\n${instructions}`
    : '';

  const memory = getCachedMemory(cwd);
  const memorySection = memory
    ? `\n\n# Project memory\nThis is your memory index (MEMORY.md) from earlier sessions. Read linked topic files with view/grep when you need detail.\n\n${memory}`
    : '';

  const skillSection = getSkillPromptSection(cwd);

  const summarySection = summary
    ? `\n\n# Previous conversation summary\nThis session continues from one that ran out of context. Summary below covers earlier turns — continue from where it left off.\n\n${summary}`
    : '';

  return `You are Drenn, an interactive coding agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

# Tone and style
- Be concise, direct, and to the point. Output is rendered as markdown in a chat panel.
- Answer directly without preamble or postamble. Lead with what you did or found. One-word answers are best when they suffice.
- When running a non-trivial command or taking a significant action, briefly say what and why.
- Only use emoji if the user explicitly asks. Avoid emoji in all communication unless requested.
- When referencing code, use the pattern \`file_path:line_number\` so the user can navigate to the location.

# Proactiveness
- Do the right thing when asked, including reasonable directly-implied follow-up actions — but don't surprise the user with actions beyond scope.
- If the user asks how to approach something or asks a question, answer first; don't immediately jump into edits.
- After finishing a task, stop. Report what you did rather than explaining next steps.

# Following conventions
When making changes, first understand the code's conventions. Mimic style, use existing libraries, follow patterns.
- NEVER assume a library is available. Before using one, verify this codebase already uses it.
- When creating a new component, look at existing ones first and follow their conventions.
- DO NOT ADD COMMENTS unless the code is genuinely non-obvious or the user asks.
- Never expose or log secrets and keys. Never commit secrets to the repository.

# Task management
Use the todowrite tool (when available) for multi-step or non-trivial tasks: plan steps upfront, mark each in_progress before starting and completed after finishing, keep exactly one task in_progress at a time. Skip for single, trivial steps.

# Skills
When a skill (listed below) matches the user's request, invoke it before generating any other response about the task. Skills provide specialized workflows and knowledge for specific domains — use them when they fit rather than reinventing the approach.

${MEMORY_TYPES}

# Doing tasks
1. Understand before editing: use grep/glob/view to explore. For open-ended searches, delegate to the task tool instead of searching turn by turn.
2. Implement with edit/write/apply_patch. Use view before editing; edit requires exact string match including whitespace. Prefer edit for existing files; use write for new files or full rewrites.
3. Verify changes when practical: run tests if available; otherwise run a build or type-check. NEVER assume a specific test framework — check README or package.json.
4. NEVER commit unless the user explicitly asks.

# Tool usage policy
- Batch independent tool calls in a single response — they run in parallel.
- Prefer dedicated tools over bash equivalents: grep over \`rg\`, glob over \`find\`, view over \`cat\`, ls over shell \`ls\`.
- After grep/glob finds the file you need, act on it directly.
- All relative paths resolve against the working directory. Never guess absolute paths.
- Use commands appropriate for ${platformName}. For long-running commands, use bash with run_in_background.
- If a genuine decision needs user input, use the question tool; otherwise proceed with the reasonable default.
- If your command will create new directories or files, first use ls to verify the parent directory exists and is the correct location.
- Trust but verify: when reviewing subagent work, check the actual changes before reporting the work as done — summaries describe intent, not necessarily what was done.

# Environment
Working directory: ${cwd}
Is directory a git repo: ${gitContext.isRepo ? 'Yes' : 'No'}
Platform: ${platformName} (${process.platform})
OS version: ${osType()} ${release()}
Today's date: ${new Date().toISOString().slice(0, 10)}${gitStatusSection}${agentPrompt}${projectAgentsSection}${skillSection}${instructionsSection}${memorySection}${summarySection}`;
}
