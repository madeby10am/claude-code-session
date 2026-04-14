# Session Click Focus & New Session Button

## Context

When clicking a session card in the Pixel Agent sidebar, it currently executes `claude-vscode.editor.open`, which opens a **new** Claude Code chat. Users expect clicking an existing session to focus that session's existing tab (editor or terminal) in VS Code. A separate "New Session" button is needed for intentionally starting a fresh chat.

## Changes

### 1. New Session "+" Button

Add a `+` button to the right of the "Sessions" header in `src/panel.ts`.

**HTML** (line 704): Wrap the header in a flex container with the button:
```html
<div class="section-header" style="display:flex; justify-content:space-between; align-items:center;">
  Sessions
  <button id="new-session-btn" title="New session" ...>+</button>
</div>
```

**JS**: Click handler posts `{ type: 'newSession' }` to the extension host.

**Handler** in `handleWebviewMessage()`: Executes `claude-vscode.editor.open`. Falls back to creating a terminal running `claude` if the command fails.

### 2. Session Click → Focus Existing Tab

Replace the `openSession` handler in `handleWebviewMessage()` (lines 91-101) with a hybrid tab-finding strategy:

1. **Check `terminalMap`** — a `Map<string, vscode.Terminal>` on the Panel class. If we previously opened a terminal for this sessionId and it's still alive, call `terminal.show()`.
2. **Scan `vscode.window.tabGroups.all`** — look for `TabInputWebview` tabs with a Claude-related `viewType`. Focus the tab if found.
3. **Scan `vscode.window.terminals`** — look for a terminal whose `name` includes the sessionId prefix (first 8 chars). Show it if found.
4. **Fallback** — create a new terminal named `Claude: <sessionId.slice(0,8)>`, run `claude --resume <sessionId>`, store in `terminalMap`.

**Cleanup**: Register `vscode.window.onDidCloseTerminal` in `registerListeners()` to prune dead entries from `terminalMap`.

## Files Modified

- `src/panel.ts` — all changes are here:
  - Class property: `private terminalMap = new Map<string, vscode.Terminal>()`
  - `registerListeners()` (~line 104): add `onDidCloseTerminal` cleanup
  - `handleWebviewMessage()` (lines 82-102): rewrite `openSession`, add `newSession`
  - `buildHtml()` HTML template (line 704): add `+` button with flex header
  - `buildHtml()` CSS (~line 628): add dark-mode button style
  - `buildHtml()` JS (~line 986): add click listener for `#new-session-btn`

## Verification

1. **Compile**: `npm run compile` — no errors
2. **New Session button**: Click `+` next to "Sessions" header → opens a fresh Claude Code editor tab
3. **Click existing session (terminal)**: Open a Claude terminal, then click its session card → terminal focuses (no new tab)
4. **Click existing session (no tab)**: Click a session with no open tab → new terminal opens with `claude --resume <id>`
5. **Terminal cleanup**: Close a Claude terminal, then click the session → creates a new terminal (doesn't try to show closed one)
