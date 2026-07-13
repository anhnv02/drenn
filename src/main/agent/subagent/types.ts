import type { PermissionConfig } from '../../permission/ruleset';

export interface SubAgentConfig {
  name: string;
  description: string;
  mode: 'primary' | 'subagent' | 'all';
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  steps?: number;
  color?: string;
  variant?: string;
  prompt?: string;
  hidden?: boolean;
  native?: boolean;
  permission?: PermissionConfig;
  options?: Record<string, unknown>;
  scope?: 'project';
  origin?: string;
}

export interface SubAgent {
  config: SubAgentConfig;
}

export interface TaskParams {
  description: string;
  prompt: string;
  subagent_type: string;
  task_id?: string;
  background?: boolean;
}

export const DEFAULT_SUBAGENTS: SubAgentConfig[] = [
  {
    name: 'build',
    description: 'The default agent. Executes tools based on configured permissions.',
    mode: 'primary',
    native: true,
    permission: {
      '*': 'allow',
      doom_loop: 'ask',
      question: 'allow',
      plan_enter: 'allow',
    },
  },
  {
    name: 'plan',
    description:
      'Software architect for read-only planning. Researches the codebase, then returns a step-by-step implementation plan with the critical files and trade-offs. All mutating tools are disallowed.',
    mode: 'all',
    native: true,
    temperature: 0.1,
    prompt: `You are in plan mode: a read-only pass. Editing tools (edit, write, apply_patch) are blocked at the permission layer, and bash only runs read-only commands (ls, cat, grep, find, git status/log/diff/show, ...) — do not attempt to change anything.

1. Research first: use grep/glob/ls/view (and read-only bash for git history) until you understand the current behavior. Ground every claim in real file contents, citing file paths and line numbers.
2. Then produce a concrete implementation plan: which files to change, what to change in each, in what order, and how to verify the result.
3. Call out risks, trade-offs, and open questions. If a decision genuinely needs the user's input, use the question tool instead of guessing.
4. When the plan is final, call exit_plan with the full plan to ask the user for approval. If approved, plan mode ends and you implement it immediately; if rejected, revise the plan based on their feedback.

Do not write out full code. Describe each change precisely enough that it can be applied without redoing your research, and keep the plan as short as it can be while staying unambiguous.`,
    permission: {
      '*': 'allow',
      question: 'allow',
      plan_exit: 'allow',
      edit: { '*': 'deny' },
      write: { '*': 'deny' },
      apply_patch: { '*': 'deny' },
    },
  },
  {
    name: 'general',
    description:
      'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident you will find the right match in the first few tries, use this agent to perform the search for you.',
    mode: 'subagent',
    native: true,
    prompt: `You are an autonomous sub-agent completing a delegated task. The caller sees ONLY your final message, so everything that matters — findings, decisions, files changed, verification results — must be restated there.

- Work the task to completion on your own; you cannot ask the user anything mid-run.
- If the task is research-only, do not modify any files.
- When you change code, verify it (run, build, or type-check) when practical before reporting success.
- End with a concise summary of what you did and where, citing file paths and line numbers.`,
    permission: {
      '*': 'allow',
      todowrite: 'deny',
    },
  },
  {
    name: 'explore',
    description:
      'Fast, read-only agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase. It locates code and reports back; it never modifies anything.',
    mode: 'subagent',
    native: true,
    temperature: 0.1,
    prompt: `You are a fast, read-only code explorer. Your job is to LOCATE and REPORT — never to modify anything.

- Use grep/glob/ls/view to find what was asked; read only the excerpts you need, not whole files.
- bash is for read-only inspection only (git log, git show, find, wc). Never run a command that writes files, installs packages, or changes any state.
- Answer with conclusions plus precise file:line references — do not paste large file contents back.
- If you can't find it, say exactly what you searched and where it is NOT, instead of guessing.
- Be brief: the caller only sees your final message.`,
    permission: {
      '*': 'deny',
      grep: 'allow',
      glob: 'allow',
      ls: 'allow',
      view: 'allow',
      bash: 'allow',
      fetch: 'allow',
      websearch: 'allow',
    },
  },
  {
    name: 'compaction',
    description: 'Hidden agent for conversation compaction.',
    mode: 'primary',
    native: true,
    hidden: true,
    permission: { '*': 'deny' },
  },
  {
    name: 'title',
    description: 'Hidden agent for generating session titles.',
    mode: 'primary',
    native: true,
    hidden: true,
    temperature: 0.5,
    maxTokens: 200,
    permission: { '*': 'deny' },
  },
  {
    name: 'summary',
    description: 'Hidden agent for generating conversation summaries.',
    mode: 'primary',
    native: true,
    hidden: true,
    permission: { '*': 'deny' },
  },
];
