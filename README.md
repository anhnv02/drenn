<p align="center">
  <picture>
    <source srcset="build/drenn_logo_dark_text.png" media="(prefers-color-scheme: light)">
    <source srcset="build/drenn_logo_white_text.png" media="(prefers-color-scheme: dark)">
    <img width="260" src="build/drenn_logo_white_text.png" alt="Drenn logo">
  </picture>
</p>

<h3 align="center">Your own AI coding agent — plus a unified view of Claude Code, opencode, and GitHub Copilot sessions</h3>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/Electron-43-9FEAF9?logo=electron&logoColor=black" alt="Electron 43">
  <img src="https://img.shields.io/badge/TypeScript-React%2018-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center"><img src="build/Screenshot 2026-07-13 at 18.01.34.png" width="800" alt="Drenn screenshot"></p>

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Develop](#develop)
- [Architecture Notes](#architecture-notes)
- [Contributing](#contributing)
- [License](#license)

## Features

### 🗂️ Sessions & History

- **Sessions Panel** — sessions grouped by project, sourced from Claude Code (`~/.claude`), opencode (`opencode.db`), GitHub Copilot (VS Code `workspaceStorage`), and in-app local sessions. Each session shows diff stats and relative time.
- **Auto Title Generation** — generates session titles from the first user message.

### 💬 Chat & Agent Loop

- **Chat Panel** — real-time streaming transcript of agent steps (thinking, content, tool use/results) with a Markdown-rendered input box, model picker, and mode picker.
- **Agent Loop** — full agentic loop with OpenAI-compatible streaming + tool calling, up to 20 iterations per turn, with abort/cancel support, mid-run message steering, and exponential backoff retry (1s→32s, max 10 retries).
- **Agent Modes** — `default` (ask permission for everything), `acceptEdits` (auto-approve file edits), `plan` (read-only, no mutations), `bypassPermissions` (auto-approve everything with safety floors).
- **Context Compaction** — auto-summarizes long conversations to stay within token limits (95% of context window threshold, `chars/4` heuristic).

### 📝 Changes & Files

- **Changes / Files Panel** — split into **Current** (git HEAD vs working tree) and **Session** (reconstructed from the session's own edit/write tool calls) tabs, plus an expandable file tree; clicking a file opens a floating Monaco diff editor with prev/next navigation and session vs. disk diff scopes.
- **Integrated Terminal** — xterm.js terminal multiplexer backed by `node-pty` for persistent shell sessions.
- **Copy Path** — right-click context menu on file items to copy absolute or relative path.

### 🔒 Permissions & Safety

- **Permission System** — tool-level approval dialog with "Allow", "Allow for session", and "Deny" options; split-button with always-allow dropdown; pattern-based global rules (e.g. `"git *": "allow"`) and per-session remembered approvals.

### 🧠 Memory, Skills & Sub-agents

- **Memory** — project-scoped persistent memory (MEMORY.md index + topic files) that survives across sessions, stored under `~/.config/drenn/memory/`.
- **Skills** — slash-command invocable prompts (SKILL.md files) with dynamic `` !`command` `` shell substitutions, scanned from `.drenn/skills/`, `.claude/skills/`, `~/.config/drenn/skills/`, and `~/.claude/skills/`.
- **Sub-agents** — agent registry with LLM-driven generation, per-agent config (temperature, topP, steps, color, disabledTools), project-scoped agents (`.claude/agents`, `.drenn/agent`), background job support, and session management.
- **Custom Commands** — user-defined commands with template arguments.

### 🔌 Integrations

- **MCP Support** — Model Context Protocol client for loading external tool servers dynamically, with a full config UI (stdio/SSE forms, test & save).
- **LSP Integration** — Language Server Protocol for real-time diagnostics (TypeScript, Go, Python, Rust configurable via Settings).
- **19 Built-in Tools** — `view`, `glob`, `grep`, `ls`, `edit`, `write`, `bash`, `fetch`, `apply_patch`, `todowrite`, `memory`, `question`, `sourcegraph`, `websearch`, `bash_output`, `kill_shell`, `diagnostics`, `task` (sub-agent delegation), `exit_plan`.

### ⚙️ Configuration

- **Provider & Model Config** — custom OpenAI-compatible provider setup with model picker, per-model temperature/topP/maxTokens/streaming settings, and built-in free models (MiMo v2.5, DeepSeek v4 Flash) plus Xiaomi MiMo models.
- **Native macOS** — traffic lights (`titleBarStyle: 'hiddenInset'`) with a custom draggable title bar and breadcrumb pill.

## Tech Stack

| Layer    | Technology                                         |
| -------- | -------------------------------------------------- |
| Desktop  | Electron 43, electron-vite 6                       |
| Frontend | React 18, TypeScript, Vite 8                       |
| Editor   | Monaco Editor (floating diff viewer)               |
| Terminal | xterm.js 6 (`@xterm/xterm`), node-pty              |
| Styling  | Plain CSS (per-component) + shared theme variables |
| Markdown | react-markdown + remark-gfm                        |
| Storage  | Plain JSON files under `~/.config/drenn/`          |

## Project Structure

<details>
<summary>Click to expand full <code>src/</code> tree</summary>

```
src/
├── main/                       # Electron main process
│   ├── index.ts                # Entry point
│   ├── window.ts               # BrowserWindow creation
│   ├── ipcHandlers.ts          # All ipcMain.handle registrations (with memoizing cache)
│   ├── git.ts                  # Git operations (file listing, diff, check-ignore)
│   ├── terminal.ts             # node-pty terminal management
│   ├── agent/                  # Agent orchestration
│   │   ├── index.ts            # AgentService — agentic loop, streaming, tool execution
│   │   ├── types.ts            # AgentEvent, ChatMessage, TokenUsage
│   │   ├── textToolCall.ts     # TextToolCallFilter — convert leaked markup to real ToolCalls
│   │   ├── titleGenerator.ts   # Auto-generate session titles via LLM
│   │   ├── externalImport.ts   # Seed LLM history from external session transcripts
│   │   ├── historyStore.ts     # Persist/reload LLM wire history per session
│   │   ├── memoryStore.ts      # Per-project memory index management
│   │   ├── systemPrompt.ts     # Build system prompt from project instructions + skills
│   │   └── subagent/           # Sub-agent system (registry, permissions, sessions, background jobs)
│   ├── tools/                  # Tool implementations (19 tools)
│   │   ├── index.ts            # createAllTools() factory
│   │   ├── types.ts            # BaseTool, ExecutionContext, ToolCall, ToolResponse
│   │   ├── view.ts, glob.ts, grep.ts, ls.ts
│   │   ├── edit.ts, write.ts, bash.ts, fetch.ts
│   │   ├── applyPatch.ts, todowrite.ts, memory.ts
│   │   ├── question.ts, sourcegraph.ts, websearch.ts
│   │   ├── diagnostics.ts, task.ts, exitPlan.ts
│   │   ├── backgroundShells.ts # bash_output, kill_shell
│   │   ├── outputStore.ts      # Tool output truncation + disk persistence
│   │   ├── pathUtil.ts         # Absolute path resolution / escape check
│   │   └── readOnlyCommands.ts # Bash commands allowed in plan mode
│   ├── permission/             # Permission system
│   │   ├── index.ts            # PermissionServiceImpl (remember, pattern rules, IPC dialog)
│   │   ├── types.ts            # PermissionRequest, PermissionResponse, PermissionService
│   │   ├── patterns.ts         # Glob-style pattern matching for commands
│   │   └── ruleset.ts          # PermissionRuleset evaluation, tool filtering by mode
│   ├── llm/
│   │   └── openaiClient.ts     # OpenAI-compatible streaming/non-streaming provider
│   ├── mcp/                    # Model Context Protocol client
│   │   ├── index.ts            # loadMCPTools() — connect, list, wrap, close
│   │   ├── client.ts           # MCP server connection & tool discovery (stdio JSON-RPC 2.0)
│   │   ├── mcpTool.ts          # MCPToolWrapper (wraps MCP tools as BaseTool)
│   │   └── types.ts            # MCPServer, MCPTool, MCPToolCall
│   ├── lsp/                    # Language Server Protocol
│   │   ├── manager.ts          # LSPManager — lifecycle for all language servers
│   │   ├── client.ts           # LSPClient — JSON-RPC transport
│   │   └── protocol.ts         # LSP type definitions
│   ├── history/                # Session log readers (read-only)
│   │   ├── index.ts            # Dispatcher by session prefix (claude:, opencode:, copilot:)
│   │   ├── claudeCode.ts       # ~/.claude/projects/**/*.jsonl
│   │   ├── opencode.ts         # opencode.db (SQLite via execFile)
│   │   ├── copilot.ts          # workspaceStorage/**/chatSessions/*.jsonl (event replay)
│   │   └── changeUtils.ts      # Shared line-diff/accumulation logic
│   ├── config/
│   │   ├── settingsStore.ts    # Plain JSON settings (~/.config/drenn/settings.json)
│   │   ├── providerStore.ts    # Plain JSON providers (~/.config/drenn/providers.json)
│   │   └── paths.ts            # All ~/.config/drenn/ path constants
│   ├── session/
│   │   ├── localSessions.ts    # Local session JSONL files (~/.config/drenn/local/)
│   │   └── continuations.ts    # Overlay logs for external sessions
│   ├── skills/
│   │   └── index.ts            # Skill discovery, caching, rendering, system-prompt injection
│   ├── commands/                # Custom user commands
│   ├── compact/
│   │   └── index.ts            # Context compaction (proactive + reactive)
│   ├── checkpoints/
│   │   └── index.ts            # Pre-change file snapshots, revert support
│   ├── hooks/
│   │   └── index.ts            # Lifecycle hook runner (9 event types)
│   └── editor/
│       └── index.ts            # External editor integration
├── preload/
│   └── index.ts                # contextBridge — exposes window.api (AgentWindowApi)
├── renderer/                   # React 18 UI
│   └── src/
│       ├── App.tsx             # Three-panel layout + session switching
│       ├── api.ts              # Typed wrapper around window.api
│       ├── monacoSetup.ts      # Monaco Editor loader config
│       ├── theme.css           # Shared CSS variables (dark theme)
│       ├── components/
│       │   ├── SessionsPanel.tsx    # Left panel — project-grouped session list
│       │   ├── ChatPanel.tsx        # Center — transcript + streaming + input
│       │   ├── ChatUserBubble.tsx   # User message bubble
│       │   ├── ChatToolCall.tsx     # Collapsible tool call display
│       │   ├── ChangesPanel.tsx     # Right — Current/Session tabs + file tree
│       │   ├── DiffModal.tsx        # Floating Monaco diff editor
│       │   ├── TitleBar.tsx         # Custom draggable title bar + breadcrumb
│       │   ├── TerminalPanel.tsx    # xterm.js terminal multiplexer
│       │   ├── PermissionDialog.tsx # Tool approval modal
│       │   ├── QuestionDialog.tsx   # Agent question response dialog
│       │   ├── SettingsModal.tsx    # Provider & model configuration
│       │   ├── AgentsTab.tsx        # Sub-agent management (create/edit/delete)
│       │   ├── MCPTab.tsx           # MCP server configuration UI
│       │   ├── PermissionsTab.tsx   # Saved permission rules + patterns viewer
│       │   ├── ConfirmDialog.tsx    # Modal confirm/alert dialog
│       │   ├── ContextMenu.tsx      # Right-click context menu
│       │   ├── RubikLoader.tsx      # Animated "agent working" indicator
│       │   ├── Toast.tsx            # Toast notification stack
│       │   ├── ResizeHandle.tsx     # Draggable panel resizer
│       │   ├── Codicon.tsx          # VS Code icon font component
│       │   ├── TreeIcons.tsx        # File tree expand/collapse icons
│       │   ├── terminalTypes.ts     # TerminalInstance interface
│       │   └── fileTree.ts          # File tree data transformation
│       └── shared/
│           ├── relativeTime.ts      # Human-readable time formatting
│           ├── Markdown.tsx         # Markdown renderer component
│           └── confirm.tsx          # ConfirmProvider / useConfirm() hook
└── shared/                     # Types shared across all three processes
    ├── ipc.ts                  # IPC channel names + AgentWindowApi interface (55+ channels)
    ├── types.ts                # Session, FileChange, Transcript, Provider, AgentInfo, etc.
    └── sessionDiff.ts          # Diff computation utilities
```

</details>

## Develop

```sh
# Install dependencies
npm install

# Start dev server (HMR for renderer, auto-restart for main/preload)
npm run dev

# Or use the convenience script (installs deps + extracts Electron if needed)
./dev.sh
```

### Build & Preview

```sh
npm run build    # Production build into out/
npm start        # Preview the production build
```

### Distribution

```sh
npm run dist     # Build + package (DMG/ZIP for macOS, NSIS/ZIP for Windows, AppImage/deb for Linux)
npm run dist:dir # Build + package as directory (for testing)
```

### Type Checking

There is no linter configured. Type-check the two halves separately:

```sh
npx tsc --noEmit -p tsconfig.node.json   # main + preload + shared
npx tsc --noEmit -p tsconfig.web.json    # renderer + shared
```

`npm run build` also fails on type errors, so it doubles as a full check.

### Tests

```sh
npx vitest run                            # unit tests (src/__tests__/)
npx vitest                                # watch mode
```

## Architecture Notes

- **Three-process Electron split** — main, preload, renderer — wired through a single typed IPC contract in `src/shared/ipc.ts`.
- **All history/git lookups are async** (`execFile`, not `execFileSync`) to avoid blocking the main process on large databases or slow git operations.
- **Session-scoped file changes** — the Changes tab shows diffs reconstructed from each session's Edit/Write tool calls (Session tab) alongside current git HEAD diffs (Current tab). This scopes changes to one session rather than the whole working tree.
- **IPC handler caching** — expensive transcript/changes/files lookups are wrapped in a 10-second memoizing cache keyed by `channel:sessionId`.
- **Plain JSON config** — all settings, providers, and state are stored as plain JSON under `~/.config/drenn/`, with in-memory caches and sync/async read/write helpers.
- **Per-session message history** — the agent keeps conversation history in memory, keyed by session ID, with auto-compaction when approaching token limits (95% threshold).
- **Permission granularity** — approvals are remembered per exact `(session, tool, resource)` triple, not globally. Pattern rules from config provide broader allow/deny lists.
- **Main-process changes** require app restart; renderer changes hot-reload without restart (both handled automatically by `npm run dev`).

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
