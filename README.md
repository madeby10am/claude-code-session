# Claude Code Session

A VS Code sidebar extension that monitors your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions in real time — with an animated pixel-art robot companion, live activity tracking, usage meters, a token-rate chart, and a full project dashboard.

The sidebar inherits whatever VS Code theme you have active, so it always matches your editor.

## What you get

### Sticky header — project + robot status bar
The top of the sidebar shows your current **workspace name** and file path, plus a sticky **robot status bar**: a pixel-art robot that animates based on what Claude is doing (thinking, reading, editing, running, searching, delegating…) next to a live speech bubble showing the current action (e.g. *"Editing `panel.ts`"*). Different tools map to different robot animations — destructive actions even zap him.

### Sessions
Your current active Claude Code session, rendered as a card with:

- **Activity badge** — color-coded, pulsating status (Thinking / Working / Responding / Waiting / Idle)
- **Gradient border ring** — a neon border glow that changes color based on the activity state
- **Model, current file, permission mode, entrypoint (VS Code / CLI / Desktop), turn count, tool count**
- **Input / output token counters** — per-turn *and* cumulative
- **Context meter** — a visual progress bar of context-window usage that shifts from green → yellow → red
- **"YOUR TURN" badge** when Claude is waiting for you
- **Started at / elapsed duration** ticker that updates every second
- **+ button** to spin up a new session

Click the card to jump to or resume that session's terminal.

### Usage
Two pacing meters showing your Claude plan's consumption:

- **Session** (resets every 5 hours) — how much of the current window you've burned
- **This week** (resets every 7 days) — weekly budget

Each bar has a **time-elapsed marker** that shows how far through the window you are, and the fill color is **pace-based**: green when you're under-pacing, yellow on-pace, orange/red when you're burning faster than the clock. Includes reset countdown and an `EXTRA USAGE` badge when you cross into overage territory. Reads live data from your Claude credentials.

### Token Activity
A compact bar chart of tokens spent over time, with:

- **Vertical-gradient bars** — green at low usage, warming to yellow/orange/red at the peaks
- **Connect-the-tops line + dot markers** — showing the trend across buckets
- **Y-axis ticks** auto-rounded to nice numbers (1k / 2k / 5k…)
- **Time-window stepper** — `[<] 5h [>]` with arrows to cycle through 5m / 15m / 30m / 1h / 5h / 12h / 24h, or click the label for a dropdown
- **Total tokens + message count** in the header

### Git Status
Everything about the current repo at a glance:

- Repo name (clickable → opens on GitHub), branch, uncommitted count, ahead/behind arrows
- Last commit message + timestamp, total commits, contributors, branch count, tags, stashes
- When the remote is a GitHub repo: visibility (public/private), stars, forks, open issues, open PRs, last-pushed, created date, disk size

### Recent Files
Files Claude has touched in this session, click-to-open. Updates as Claude reads/writes.

### Session History
A rolling list of your recent Claude sessions with titles and "last seen" timestamps, so you can quickly jump back into past work.

### MCP Servers
Every MCP server currently connected to your Claude setup, with status dots.

### Skills
A searchable, filterable browser of every Claude Code skill installed on your machine:

- **Search box** to filter by name or description
- **Source filter** — USER vs PLUGIN
- **Category chips** — Planning, Design, Review, Testing, SEO & Content, Automation, Integrations, Dev Tools, Other
- Click any skill to inject `/<skill-name>` into your Claude prompt

### CLI Tools
Grouped list of developer CLIs the extension detects on your system (Claude, Node/package managers, Git, cloud tools, etc.). Click an installed one to drop its name into the prompt.

## Layout controls

Every section can be:

- **Collapsed** by clicking its header (chevron rotates; per-section hover color — blue for Sessions, amber for Usage, emerald for Token Activity, and so on)
- **Pinned** to the top with the pushpin icon — pinned sections stick under the header while you scroll
- **Reordered** by drag-and-drop

State persists across reloads.

## Install

### From VSIX

Download the `.vsix` from [Releases](https://github.com/madeby10am/claude-code-session/releases), then:

```bash
code --install-extension claude-code-session-<version>.vsix
```

### From source

```bash
git clone https://github.com/madeby10am/claude-code-session.git
cd claude-code-session
npm install
npm run compile
```

Then either press **F5** in VS Code to launch an Extension Development Host, or use `npm run deploy` to copy the built files into your installed extension folder and reload the window.

## Usage

1. Open the **Claude Code Session** sidebar (robot icon in the activity bar)
2. Start a Claude Code session in your terminal (`claude`) or the VS Code extension
3. Watch the sidebar update in real time

**Keyboard shortcut:** `Cmd+Shift+J` (macOS) / `Ctrl+Shift+J` (Windows/Linux) opens the session panel as a split editor.

## How it works

The extension watches `~/.claude/projects/` for JSONL session log files and parses them for:

- Session metadata (model, mode, entrypoint)
- Token usage (input, output, cache-aware)
- Activity state (idle, thinking, tooling, responding, sleeping)
- Tool usage (file reads, edits, bash commands, searches)
- Context-window utilization

All rendering happens in an inline webview with zero runtime dependencies.

## Requirements

- VS Code 1.85+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and used at least once (creates `~/.claude/projects/`)

## Development

```bash
npm run compile    # Build once
npm run watch      # Watch mode
npm test           # Run tests
npm run deploy     # Build + copy to installed extension (then reload VS Code)
```

## License

MIT
