# Claude Code Session

A VS Code sidebar extension that monitors your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions in real time — with live per-session cards that follow the tab you're in, thin always-visible usage meters, a token-rate chart, and a git activity feed across all your project repos.

The sidebar inherits whatever VS Code theme you have active, so it always matches your editor.

## What you get

### Sticky header — folder + usage
Always visible at the top: the **folder name** (with path, click to reveal), then two thin full-width usage bars, **Session** on top and **Week** underneath, with a ↻ refresh and an `EXTRA` badge when you cross into overage.

Each bar has a **time-elapsed marker** showing how far through the window you are, and the fill is **pace-based**: green when under-pacing, yellow on-pace, orange/red when burning faster than the clock. Reset countdown and plan appear in the tooltip. Reads live data from your Claude credentials.

> The pixel-art robot status bar is parked in an inert `<template>` at the bottom of `src/webview/body.html`. Move it back into `#sticky-top` to restore it.

### Sessions
One compact card per open session, all with the same layout:

- Status dot, **session name**, and a color-coded **state tag** (Working / Thinking / Waiting / Your turn / Sleeping)
- **Model** chip, permission **mode**, and **start time** (with a live elapsed ticker for today's sessions)
- Thin **context bar** with percentage
- Hover for the details: current file, source, turns, tools, in/out tokens

The session whose Claude editor tab is active gets the activity-colored ring. **Click another Claude tab and the sidebar jumps to that session instantly.** Click any card to bring its tab to the front (or reopen/resume it if it's closed).

- **Closing a Claude tab** removes its session from the list. A **×** on hover removes one manually (e.g. terminal sessions). A removed session comes back if it shows new activity.
- Background Agent SDK sessions (e.g. automated reviews) are never listed.
- A big **+ New session** button sits under the cards.

### Token Activity
A compact bar chart of tokens spent over time, with:

- **Vertical-gradient bars** and a smooth **connect-the-tops line** with dot markers
- **Y-axis ticks** auto-rounded to nice numbers (1k / 2k / 5k…)
- **Time-window stepper** — `[<] 5h [>]` to cycle 5m / 15m / 30m / 1h / 5h / 12h / 24h, or click the label for a dropdown
- **All / This session** toggle: scope the chart to the session you're focused on
- **Pace line**: average tokens per minute and the peak slice

### Git Status
Follows the repo of the session you're in. Your workspace folder doesn't need to be a repo itself, so a folder of projects works fine.

- **Last activity** headline: the latest push or pull across *all* open sessions' repos ("Pushed · my-repo · 3m ago"), with a pulsing dot when it happened in the last minute
- **History** (expandable): recent pushes, pulls, merges and commits across every session's repo
- Repo link (opens on GitHub) with a private/public chip, branch with ↑↓, changes, last commit
- Issues, PRs and stashes at a glance

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

1. Open the **Claude Code Session** sidebar (icon in the activity bar)
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

Git status and history are read straight from `git` (reflogs), scoped to the repos your sessions run in. Everything is per VS Code window.

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
