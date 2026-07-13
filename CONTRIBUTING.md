# Contributing to Drenn

We want to make it easy for you to contribute to Drenn. Here are the most common types of changes that get merged:

- Bug fixes
- New tools or improvements to existing tools
- Additional MCP servers or LSP integrations
- Improvements to LLM performance or model support
- Fixes for environment-specific quirks
- Missing standard behavior
- Documentation improvements

## Developing Drenn

- Requirements: Node.js 18+, npm
- Install dependencies and start the dev server from the repo root:

  ```sh
  npm install
  npm run dev
  ```

`npm run dev` starts the Electron app with HMR for the renderer and auto-restart for main/preload processes.

### Building & Preview

```sh
npm run build    # Production build into out/
npm start        # Preview the production build
```

### Running Tests

```sh
npx vitest run                            # run all tests
npx vitest                                # watch mode
```

Tests live in `src/__tests__/` mirroring the `src/` layout.

### Running Type Checks

There is no linter configured. Type-check the two halves separately (they have different `lib`/DOM settings):

```sh
npx tsc --noEmit -p tsconfig.node.json   # main + preload + shared
npx tsc --noEmit -p tsconfig.web.json    # renderer + shared
```

`npm run build` also fails on type errors, so it doubles as a full check.

## Pull Request Expectations

### Issue First Policy

**All PRs must reference an existing issue.** Before opening a PR, open an issue describing the bug or feature. This helps maintainers triage and prevents duplicate work. PRs without a linked issue may be closed without review.

- Use `Fixes #123` or `Closes #123` in your PR description to link the issue
- For small fixes, a brief issue is fine — just enough context for maintainers to understand the problem

### General Requirements

- Keep pull requests small and focused
- Explain the issue and why your change fixes it
- Before adding new functionality, ensure it doesn't already exist elsewhere in the codebase

### UI Changes

If your PR includes UI changes, please include screenshots or videos showing the before and after. This helps maintainers review faster and gives you quicker feedback.

### Logic Changes

For non-UI changes (bug fixes, new features, refactors), explain **how you verified it works**:

- What did you test?
- How can a reviewer reproduce/confirm the fix?

### No AI-Generated Walls of Text

Long, AI-generated PR descriptions and issues are not acceptable and may be ignored. Respect the maintainers' time:

- Write short, focused descriptions
- Explain what changed and why in your own words
- If you can't explain it briefly, your PR might be too large

### PR Titles

PR titles should follow conventional commit standards:

- `feat:` new feature or functionality
- `fix:` bug fix
- `docs:` documentation or README changes
- `chore:` maintenance tasks, dependency updates, etc.
- `refactor:` code refactoring without changing behavior
- `test:` adding or updating tests

Examples:

- `fix: resolve crash on startup`
- `feat: add sourcegraph tool`
- `docs: update contributing guidelines`
- `refactor: simplify permission check logic`

### Style Preferences

These are not strictly enforced, they are just general guidelines:

- **Functions:** Keep logic within a single function unless breaking it out adds clear reuse or composition benefits.
- **Destructuring:** Do not do unnecessary destructuring of variables.
- **Control flow:** Avoid `else` statements.
- **Error handling:** Prefer `.catch(...)` instead of `try`/`catch` when possible.
- **Types:** Reach for precise types and avoid `any`.
- **Variables:** Stick to immutable patterns and avoid `let`.
- **Runtime APIs:** Prefer native Node.js APIs (e.g. `fs/promises`, `node:child_process`) over adding new dependencies when they fit the use case.

## Feature Requests

For net-new functionality, start with a design conversation. Open an issue describing the problem, your proposed approach (optional), and why it belongs in Drenn. Please wait for that approval instead of opening a feature PR directly.

## Project Structure

Drenn follows the standard three-process Electron architecture:

- `src/main/` — Electron main process (agent loop, tools, IPC handlers)
- `src/preload/` — Bridge between renderer and main (`window.api`)
- `src/renderer/` — React 18 UI
- `src/shared/` — Types and IPC contract shared across all three processes

See [README.md](README.md) for the full project structure.

## Reporting Issues

Open a GitHub issue with:

- A clear title and description
- Steps to reproduce (if applicable)
- Expected vs. actual behavior
- Your OS and Node.js version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
