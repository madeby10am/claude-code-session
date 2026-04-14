# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
npm run compile        # TypeScript → out/
npm run deploy         # compile + copy to installed extension (then reload VS Code window)
npm run watch          # Watch mode for development
npm test               # Run tests with Vitest
```

**Iteration loop:** `npm run deploy` → **Cmd+Shift+P → Developer: Reload Window**. The `deploy` script compiles and copies `out/*.js` directly into `~/.vscode/extensions/local.claude-code-session-0.0.1/out/`, updating the installed extension in-place. There is no separate dev server.

Alternatively, press **F5** to launch an Extension Development Host window for isolated testing.

## Architecture

A VS Code extension ("Claude Code Session") that monitors Claude Code CLI sessions and displays them in an animated pixel art sidebar.

**Data flow:** `~/.claude/projects/**/*.jsonl` → `SessionManager` → `Panel` → Webview

### Source files (`src/`)

- **extension.ts** — Entry point. Wires `SessionManager` → `Panel`, registers the `claude-code-session.sidebar` webview view provider and the `claude-code-session.open` command.
- **sessionManager.ts** — File-watches `~/.claude/projects/` for JSONL session logs. Parses entries to extract session metadata (tokens, activity state, tool usage, model, context %). Emits `Map<string, SessionState>` updates via callback with 100ms debounce. Activity state machine: `idle → user_sent → tooling → responding → idle → sleeping`.
- **panel.ts** — `WebviewViewProvider` class containing the entire inline HTML/CSS/JS for the sidebar webview in `buildHtml()`. Handles session card rendering, robot sprite animation (30 FPS, sprite frames at ~7 FPS), speech bubble, and the attention badge.

### Webview message protocol

Extension → Webview (via `postMessage`):
- `{ type: 'sessionsUpdate', sessions: SessionState[] }` — full session list on every change
- `{ type: 'projectInfo', data: { workspace, activeFile, gitBranch, gitRemote, gitUser, gitLastCommit } }`
- `{ type: 'darkMode', value: boolean }`

Webview → Extension (via `vscodeApi.postMessage`):
- `{ type: 'ready' }` — webview loaded, request initial state
- `{ type: 'openSession', sessionId: string }` — focus or resume a session terminal
- `{ type: 'newSession' }` — open a new Claude editor tab or terminal
- `{ type: 'setDarkMode', value: boolean }` — persist dark mode preference

### Session focus strategy (`focusSession`)

1. Check `terminalMap` (Panel class property) for a previously opened terminal → `show()` it
2. Scan `vscode.window.tabGroups` for a Claude webview tab → focus it
3. Scan `vscode.window.terminals` for one whose name includes the sessionId prefix (first 8 chars)
4. Fallback: create terminal named `Claude: <prefix>`, run `claude --resume <sessionId>`, store in `terminalMap`

## Key Conventions

- **Inline webview**: All HTML, CSS, and JS lives in the template string returned by `panel.ts:buildHtml()`. No separate `.html` or `.css` files.
- **Sprite sheet**: Robot character from `assets/Robot Character/Sprite sheets/Directional sprite sheets/Down sprite sheet.png`. URI injected via `webview.asWebviewUri()`. Always set `ctx.imageSmoothingEnabled = false` after `scale()`; CSS uses `image-rendering: pixelated`.
- **No runtime dependencies**: Only VS Code API and Node built-ins at runtime. `canvas` and `vitest` are dev-only.
- **Tests**: Some test files reference stale architecture classes (`StateManager`, `ActivityMonitor`, `ClaudeWatcher`) that no longer exist. Current tests use the VS Code API mock at `test/__mocks__/vscode.ts`.
