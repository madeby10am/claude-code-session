# Claude Code Session

A VS Code sidebar extension that monitors your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI sessions in real time with animated pixel art.

## Features

- **Live session monitoring** -- watches `~/.claude/projects/` for active Claude Code sessions and displays real-time stats
- **Animated gradient borders** -- each activity state (thinking, tooling, responding, waiting) gets a vibrant gradient border ring with pulsating glow
- **Activity badges** -- color-coded badges with pulse animations show what Claude is doing right now
- **Token tracking** -- per-turn and cumulative input/output tokens, with cache-aware input counts
- **Context meter** -- visual progress bar showing how much of the context window is used
- **Robot companion** -- pixel art robot in the sticky header that animates based on Claude's activity
- **Speech bubble** -- shows the current tool action (e.g., "Reading **panel.ts**") with bold file targets
- **Usage meters** -- session and weekly token usage with progress bars
- **Git status** -- branch, uncommitted changes, ahead/behind, last commit
- **Skills browser** -- searchable list of available Claude Code skills with source filters
- **MCP servers** -- connected MCP server list
- **Session history** -- recent sessions with titles and timestamps
- **Collapsible & draggable sections** -- reorder and collapse any section, state persists across reloads
- **Dark/light mode** -- dark-first design with full light mode support

## Install

### From Source

```bash
git clone https://github.com/madeby10am/claude-code-session.git
cd claude-code-session
npm install
npm run compile
```

Then either:

- **F5** in VS Code to launch an Extension Development Host
- Or copy the built extension to your VS Code extensions directory:

```bash
# macOS / Linux
mkdir -p ~/.vscode/extensions/local.claude-code-session-0.0.1
cp -r out assets package.json ~/.vscode/extensions/local.claude-code-session-0.0.1/
```

Restart VS Code and the robot icon appears in the activity bar.

### From VSIX

Download the `.vsix` file from [Releases](https://github.com/madeby10am/claude-code-session/releases), then:

```bash
code --install-extension claude-code-session-0.0.1.vsix
```

## Usage

1. Open the Claude Code Session sidebar (robot icon in the activity bar)
2. Start a Claude Code session in your terminal (`claude`) or VS Code
3. Watch the sidebar update in real time as Claude works

**Keyboard shortcut:** `Cmd+Shift+J` (macOS) / `Ctrl+Shift+J` (Windows/Linux) opens the session panel as a split editor.

## How It Works

The extension watches `~/.claude/projects/` for JSONL session log files. It parses entries to extract:

- Session metadata (model, mode, entrypoint)
- Token usage (input, output, cache)
- Activity state (idle, thinking, tooling, responding, sleeping)
- Tool usage (file reads, edits, bash commands)
- Context window utilization

All rendering happens in an inline webview with no external dependencies.

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
