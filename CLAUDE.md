# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run dev      # electron-vite dev --watch — launches the Electron app, HMR for renderer,
                  # auto-restarts the main/preload process on change
npm run build     # electron-vite build — production build into out/
npm start         # electron-vite preview — runs the out/ build
```

Tests are vitest, restricted to `src/__tests__/**/*.test.ts` (mirroring the `src/` layout);
there is no lint script configured. Type-check the two halves of the app separately (they
have different `lib`/DOM settings, see Architecture):

```sh
npx vitest run                            # unit tests (src/__tests__/)
npx tsc --noEmit -p tsconfig.node.json   # main + preload + shared
npx tsc --noEmit -p tsconfig.web.json    # renderer + shared
```

`npm run build` also fails on type errors, so it doubles as a full check.

Main-process changes require the app to restart to take effect (`--watch` does this
automatically under `npm run dev`); renderer changes hot-reload without a restart.

## Architecture

Electron app (`electron-vite`) with the standard three-process split, wired through a single
typed IPC contract in `src/shared/ipc.ts`: `IPC` channel-name constants plus the
`AgentWindowApi` interface that both the preload bridge (`src/preload/index.ts`) and the
renderer's `api.ts` wrapper are typed against. `src/shared/types.ts` holds the domain types
(`Session`, `FileChange`, `Transcript`, `AgentInfo`, etc.) shared by all three processes.

### Configuration

All config/data lives under `~/.config/drenn/` (plain JSON, no electron-store):

```
~/.config/drenn/
├── settings.json          # selectedModel, xiaomiApiKey, lsp, permissionPatterns, hooks
├── providers.json         # custom provider configs
├── mcp.json               # MCP server configs
├── permission-rules.json  # remembered "Always allow" rules (per-project keyed by cwd)
├── history/               # persisted LLM wire history per session
├── checkpoints/           # pre-change file snapshots for revert
├── continuations/         # overlay logs for external sessions (claude:/opencode:/copilot:)
├── local/                 # local session JSONL files (meta + transcript steps)
├── tool-outputs/          # full tool output content (truncated copies kept in memory)
├── commands/              # custom user commands
├── agent/                 # generated sub-agent configs (.md files, YAML frontmatter + body)
├── memory/                # per-project agent memory files (MEMORY.md + topic files)
└── skills/                # global skill definitions (SKILL.md files)
```

### `src/main/` — Electron main process

- **`history/`** — reads coding-agent session logs from disk/DB for three read-only sources:
  Claude Code (`~/.claude/projects/**/*.jsonl`), opencode
  (`~/.local/share/opencode/opencode.db`, queried via the `sqlite3` CLI through `execFile`
  - `json_extract`, never loading whole rows), and GitHub Copilot Chat in VS Code
    (`workspaceStorage/**/chatSessions/*.jsonl`, replayed via `replayEvents`).
    `history/index.ts` dispatches across the three by session-ID prefix (`claude:`,
    `opencode:`, `copilot:`) and exports `getProjects`, `getTranscript`, `getSessionCwd`,
    `getSessionChanges`, `getSessionFileOps`.
  * Local sessions created in-app use a `local:` prefix and are stored as individual JSONL
    files in `~/.config/drenn/local/` (each file: line 1 = meta `{type:'meta', cwd, title,
updatedAt}`, remaining lines = transcript steps).
  * External sessions are **continuable**: sending a message in a `claude:`/`opencode:`/
    `copilot:` session runs the in-app agent against it. The source log stays read-only —
    new turns append to a continuation overlay (`session/continuations.ts`,
    `~/.config/drenn/continuations/*.jsonl`, same step format as local sessions), and
    `getTranscript`/`getSessionChanges`/`getSessionFileOps` merge overlay onto source, and
    `getProjects` folds overlay +/- counts and mtime into the sidebar entry. On
    the first in-app run, `agent/externalImport.ts` seeds the LLM history from the
    session's transcript (plain text turns, ~48k-char cap keeping the newest turns) so
    the model remembers the earlier conversation; later runs reuse the persisted wire
    history in `~/.config/drenn/history/`.
  * Per-session file changes (Changes tab) are **not** git state — they're reconstructed by
    replaying each session's Edit/Write tool calls from its log
    (`history/changeUtils.ts` has the shared line-diff/accumulation logic), so the panel
    is scoped to one session rather than the whole working tree. Claude Code and opencode
    logs record precise before/after content, so added/removed counts are exact. Copilot
    logs only record `textEditGroup` response items (VS Code TextEdits: file URI + range-
    replace ops, no before-snapshot) so `getCopilotChanges` approximates the line counts
    from the edit shape rather than computing an exact diff.
- **`git.ts`** is the _other_ half of the Files panel: the Files tab lists the project
  tree from disk (`listFilesFor`, skipping `.git` and `node_modules` outright, dimming
  other gitignored paths via a batched `git check-ignore --stdin`), and `getDiffFor`
  builds diff content by comparing `git show HEAD:<path>` against the current
  on-disk file.
- **`ipcHandlers.ts`** registers all `ipcMain.handle` channels and wraps the expensive ones
  (`transcript`, `changes`, `files`, `diff`) in a 10s promise-memoizing cache (`cached()`),
  keyed by `channel:sessionId`, so rapid session switching doesn't re-run sqlite/log-
  parsing/git calls. `sessions:get` is cached the same way under the global key
  `sessions` — any new handler that mutates a session must call
  `invalidateCache('sessions')` or the sidebar serves stale data for up to 10s.
  `invalidateCache()` is called when a local session is mutated
  (message added, title updated, deleted) so the next read picks up the change.
  **All history/git lookups must stay async** (`execFile`, not `execFileSync`) — sqlite
  queries against a live multi-GB opencode DB or git calls have taken multiple seconds,
  and a sync call blocks the entire main process (the whole app freezes) for that
  duration.
- **`terminal.ts`** hosts node-pty terminals, one per `TerminalPanel` instance, keyed by id;
  data/exit push out over `terminal:data` / `terminal:exit`. Terminals auto-dispose on
  app quit.
- **`editor/`** — external-editor launcher stub (used by `editor:open`).
- **`skills/`** — slash-command invocable prompts stored as `SKILL.md` files (YAML
  frontmatter + markdown body) in four scan locations with project-first precedence:
  `<cwd>/.drenn/skills/` → `<cwd>/.claude/skills/` → `~/.config/drenn/skills/` →
  `~/.claude/skills/`. TTL-cached (15s). Later scan order wins on name collision.
  Skill bodies support `!`command`` inline shell substitutions (10s timeout).
  `getSkillPromptSection()` builds a system-prompt section listing available skills so the
  model knows what's available.

### `src/preload/index.ts`

The only bridge between renderer and main; exposes `window.api` (implementing `AgentWindowApi`)
via `contextBridge`. `contextIsolation: true`, `nodeIntegration: false` (see `main/window.ts`).

### `src/renderer/` — React 18 UI

VSCode-style layout wired up in `App.tsx`:
`SessionsPanel` (left, sessions grouped by project) → `ChatPanel` (center, transcript +
streaming assistant + input bar with model picker, mode picker, send/stop button) →
`ChangesPanel` (right, split into **Current** (git HEAD) and **Session** tabs, plus file
tree; opens `DiffModal`, a floating Monaco diff/file editor with prev/next navigation and
session vs. disk diff scopes) → optional `TerminalPanel` (bottom, multi-tab node-pty).
Switching the active session re-fetches changes/files for that session and
closes any open diff modal. Cmd/Ctrl+N starts a new session in the active project.
Styling is plain CSS per component (`ComponentName.css` next to `ComponentName.tsx`) plus
shared theme variables in `theme.css` (dark theme only, native macOS traffic lights via
`titleBarStyle: 'hiddenInset'`).

Additional renderer components:

- `ChatToolCall` — collapsible tool call display in chat with running/error/done states;
  renders nested sub-agent steps for `task` calls.
- `AgentsTab` — settings tab for managing sub-agents (create via LLM, edit, delete).
- `MCPTab` — full MCP server config UI (stdio/SSE forms, test & save).
- `PermissionsTab` — saved permission rules + pattern-based allow/deny management.
- `ContextMenu` — right-click menus (Copy Absolute/Relative Path on file items).
- `ConfirmDialog` / `confirm.tsx` — drop-in replacements for `window.confirm`/`alert`.
- `RubikLoader` — animated "agent is working" indicator.
- `Toast` — toast notification stack (success/error).

### IPC shape quick reference

Two flavours of channels:

- **`ipcMain.handle`** (request/response, renderer awaits): `sessions:get`,
  `sessions:create`, `sessions:delete`, `changes:get`, `files:get`, `transcript:get`,
  `transcript:clear`, `diff:get`, `checkpoints:get`, `checkpoints:revert`,
  `providers:get`, `providers:save`, `mcp:get`, `mcp:save`, `terminal:create`,
  `agent:run`, `agent:cancel`, `agent:enqueue`, `agent:mode:get`, `agent:mode:set`,
  `agents:get`, `agents:generate`, `agents:update`, `agents:delete`, `models:get`,
  `models:select`, `xiaomi:apiKey:get`, `xiaomi:apiKey:save`, `xiaomi:models:fetch`,
  `permission:rules:get`, `permission:rules:delete`, `permission:patterns:get`,
  `permission:patterns:save`, `skills:get`, `skills:run`, `session:cwd`.
- **`ipcMain.on` + push** (fire-and-forget or push only): `terminal:write/resize/dispose`,
  `chat:message` (push), `permission:request` (push), `permission:response`,
  `permission:clear-session`, `question:request` (push), `question:response`,
  `agent:event` (push), `terminal:data` (push), `terminal:exit` (push),
  `background:job` (push).

`syncChanges` and `markAsDone` are registered as no-op handlers; they're stubbed for a
future backend wiring.

## Agent System

The agent loop lives in `src/main/agent/index.ts` (`AgentService`). Renderer flow:

1. User composes a message in `ChatPanel` → `api.runAgent(sessionId, text)`.
2. `agentRun` handler (`ipcHandlers.ts`) persists the "You" step (local JSONL for `local:`
   sessions, continuation overlay for external ones — see `transcriptWriter()`), then kicks
   off `agentService.run(sessionId, text, cwd)` as an async iterator, pushing every event
   back as `agent:event`.
3. `ChatPanel` subscribes via `api.onAgentEvent` and renders streaming `content` deltas,
   running `tool_use` / `tool_result` calls (`ChatToolCall`), finalising the assistant step
   on `complete`, and surfacing errors. A "stop" button calls `api.cancelAgent(sessionId)`
   which aborts the per-session `AbortController`.

Capabilities:

- **19 built-in tools** (`src/main/tools/`): view, glob, grep, ls, edit, write, bash
  (sync or `run_in_background` → background shell), bash_output / kill_shell (poll/stop
  background shells, `backgroundShells.ts`), fetch, websearch (keyless DuckDuckGo HTML),
  applyPatch, todowrite, memory, question, exit_plan (plan-approval flow), diagnostics,
  sourcegraph, task. Registered through `createAllTools()` in `tools/index.ts`, gated by
  `permissionService` and the per-session agent mode
  (`default` / `acceptEdits` / `plan` / `bypassPermissions`); `plan` blocks edit tools
  and restricts bash to read-only commands (`readOnlyCommands.ts`), `bypassPermissions`
  auto-approves everything (hard floors — banned commands, private-network fetch —
  still apply).
- **Memory** (`tools/memory.ts`): project-scoped persistent memory stored under
  `~/.config/drenn/memory/<project-hash>/`. `MEMORY.md` is the index (loaded into context
  each session); individual topic files hold substance. Supports read/write/list/delete
  actions; write/delete blocked in plan mode.
- **Project instructions**: `agent/systemPrompt.ts` loads `CLAUDE.md`,
  `CLAUDE.local.md`, `AGENTS.md` from the session cwd plus
  `~/.config/drenn/AGENTS.md` (TTL-cached; refreshed at the start of each run) into the
  system prompt. Skills are also injected via `getSkillPromptSection()`.
- **Hooks** (`src/main/hooks/`): user commands from settings.json (`hooks` key) run at
  `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SubagentStop` /
  `SessionStart` / `PreCompact` / `Notification` / `PermissionRequest` with a JSON
  payload on stdin. Exit code 2 blocks: pre → tool refused (stderr to model), post →
  stderr appended to the result, stop/subagent-stop → stderr queued as a user message
  continuing the run (max 2 per run), prompt-submit → prompt not sent (stderr shown to
  user), permission-request → denied without a dialog (stderr to model as feedback).
  Exit-0 stdout from `UserPromptSubmit`/`SessionStart` is injected as extra context.
  `matcher` regexes test the tool name (pre/post/permission), `source`
  ('startup'/'resume', SessionStart) or `trigger` ('auto'/'error', PreCompact).
  `Notification` fires (fire-and-forget) when a permission dialog or question needs
  the user's attention; sub-agent sessions fire `SubagentStop` instead of `Stop` and
  skip `SessionStart`.
- **Checkpoints** (`src/main/checkpoints/`): edit/write/apply_patch record each file's
  pre-change content (persisted under `~/.config/drenn/checkpoints/`, max 500 per
  session); `checkpoints:revert` restores every touched file to its pre-session state
  (Revert button in the Changes tab). All writes flow through one promise chain — do not
  bypass it, parallel records race otherwise.
- **History persistence** (`agent/historyStore.ts`): each session's LLM wire history
  is written to `~/.config/drenn/history/` at the end of every run and lazily
  reloaded on the first run after a restart (sub-agent `:sub:` sessions excluded).
- **Images**: `runAgent(sessionId, text, images?)` accepts pasted images as data:
  URLs; they become OpenAI-vision `image_url` content parts (`ChatMessage.content`
  can be `ContentPart[]`) and `image` transcript blocks.
- **Thinking**: `reasoning_content`/`reasoning` stream deltas surface as `thinking`
  agent events, rendered as a collapsible block; never stored in message history.
- **Text tool-call filter** (`agent/textToolCall.ts`): some models leak tool-call
  markup into the content stream as plain text (XML-ish `<tool_call>`, token-style
  `<|tool_call_begin|>`, MiniMax-style `<minimax:tool_call>`). `TextToolCallFilter`
  intercepts these and converts them into real `ToolCall` objects.
- **Plan approval** (`tools/exitPlan.ts`): in plan mode the agent calls `exit_plan`
  with its plan; approval via `PermissionDialog` flips the session to `default` and the
  loop re-filters tools each turn, so implementation starts in the same run. Mode
  changes push an `agent:event` of `type: 'mode'` so the renderer picker stays in sync.
- **MCP integration** (`src/main/mcp/`): dynamically loads tools from external MCP
  servers via stdio (JSON-RPC 2.0, Content-Length framing). Loaded at startup from
  `settingsStore.mcpServers` via `agentService.loadMCPToolsFromConfig()`, and hot-reloaded
  immediately when the user saves MCP config via `mcp:save`. Each MCP tool is exposed as
  `mcp_<toolName>` and gated by `permissionService`. SSE transport is not yet implemented.
- **Permission system** (`src/main/permission/`): per-tool approval via an inline dialog
  (`PermissionDialog`), modelled on Claude Code. `request()` returns a
  `PermissionDecision { approved, feedback?, updatedMode? }`; denial can carry user
  feedback ("tell the agent what to do instead") which tools surface to the model via
  `deniedToolResult()`. "Always allow" saves a persistent `PermissionRule`
  `{ cwd, toolName, kind: 'exact' | 'prefix', value }` — project-scoped (keyed by session
  cwd, survives across sessions), with prefix rules for bash command prefixes
  ("git push …") and fetch URL origins. Bash matching is compound-command aware: allow
  rules (remembered or glob patterns from settings) must cover _every_ segment of
  `a && b`-style commands (`evaluateBashPatterns` / `splitCommandSegments`), and output
  redirects never auto-allow. `exit_plan`/`apply_patch` can never be remembered.
  `exit_plan` approval carries `updatedMode` ('acceptEdits' = "Yes, auto-accept edits").
  Concurrent requests queue per session in `ChatPanel` (shown one at a time).
  Renderer → main: `permission:response` (single `PermissionResponsePayload` object).
  Rules CRUD: `permission:rules:get`, `permission:rules:delete`.
  Global pattern rules: `permission:patterns:get`, `permission:patterns:save`
  (`PermissionPatternRule { pattern, action: 'allow'|'ask'|'deny' }`).
- **Question tool** (`tools/question.ts`): the agent can pause to ask the user a multiple-
  choice question; renderer renders `QuestionDialog` and replies via `question:response`.
- **Context compaction** (`src/main/compact/index.ts`): proactive compaction check before
  every LLM call (token-budget based, `chars/4` heuristic, threshold 95% of context window)
  plus reactive compaction on `context_overflow` errors (with one retry). Compacted sessions
  are rebuilt via `buildCompactSessionMessages`. Default context window: 128k tokens.
- **Sub-agent system** (`src/main/agent/subagent/`): `registry.ts` (in-memory), `store.ts`
  (load/save `.md` agents — YAML frontmatter + markdown-body prompt — from
  `~/.config/drenn/agent/`), `generator.ts`
  (LLM-driven generation from a description), `permissions.ts` (per-agent default denies),
  `sessions.ts` / `background.ts` (background jobs). Project-scoped agents loaded from
  `.claude/agents` and `.drenn/agent` directories under the session cwd (read-only in app).
  Spawn through `tools/task.ts`'s `task` tool, which `agent:run` reuses with a derived
  child session id. `AgentInfo` supports `temperature`, `topP`, `steps`, `color`,
  `disabledTools`, `prompt`, `native`, `scope`, `origin` fields.
- **LSP integration** (`src/main/lsp/`): `LSPManager` lazily starts language servers
  (`client.ts`) and exposes them to tools (currently `diagnostics`). Initialised in
  `main/index.ts` against `process.cwd()`.
- **Mid-run input** (`agent/index.ts`): messages sent while a run is active are
  steered in at the next step boundary (after the current tool batch), in the order
  typed — Claude Code style; the `'steer' | 'queue'` flag survives in the IPC
  signature for compatibility but no longer changes behavior. Each steered message
  runs the UserPromptSubmit hook like any prompt; leftovers from a just-ended run
  are drained at the start of the next one. `ChatPanel` calls `api.enqueueInput()`
  when the user sends while a run is active.
- **Title generation** (`agent/titleGenerator.ts`): auto-generated from the first user
  message via the configured provider; emitted as an `agent:event` with `type: 'title'`
  and saved via `updateLocalSessionTitle()`.
- **Tool output bounding** (`tools/outputStore.ts`): truncates large tool outputs before
  they enter `messageHistories`, persisting full content to disk for later retrieval.
- **Error classification** (matching OpenCode): `provider_error` (rate limit / 401 /
  network), `context_overflow`, `permission_denied`, `tool_not_found`, `tool_execution`,
  `max_iterations`, `cancelled`, `unknown` — plus matching retry semantics in the loop
  (exponential backoff 1s→32s, max 10 retries).

### Model selection

`models:get` returns builtin free models plus Xiaomi MiMo models, plus every
tool-calling chat-completions model from saved providers:

**Built-in free models** (opencode zen, no API key needed):

- `mimo-v2.5-free` — MiMo v2.5 (free)
- `deepseek-v4-flash-free` — DeepSeek v4 Flash (free)

**Xiaomi MiMo** (requires API key from platform.xiaomimimo.com):

- `mimo-v2.5-pro` — MiMo v2.5 Pro
- `mimo-v2.5` — MiMo v2.5

`llm/openaiClient.ts` is the OpenAI-compatible + a few other-API-shaped
provider stack (selectable per run, persisted via `settingsStore`). Each provider model
can have per-model `temperature`, `topP`, `maxTokens`, and `streaming` (non-streaming
mode) settings. `selectModel` persists `SelectedModel` (`providerId`, `modelId`);
`null` means auto-pick.
