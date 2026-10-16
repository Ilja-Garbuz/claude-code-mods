# Claude Code mods

Three mods for the Claude Code terminal (CLI). Claude Desktop, VS Code and mobile keep their normal look.

| Mod | What it does |
| --- | --- |
| **session-panel** | A side panel docked on the right: live 5-hour and weekly limits, context use with a per-category breakdown, the model and effort with switchers, skills with their context cost, connector status, the working directory, the Claude Code version and toggles for your mods. `/panel` opens it; the ✕ collapses it to a « button. |
| **message-style** | Your prompts as opencode-style panels: full width, text on the right, a thin blue stripe on the right edge. |
| **mod-manager** | `/mods` lists your installed plugins and mods with on/off toggles that apply in the open session, no restart. The side panel's Mods section uses it. |

## Install

You need Claude Code 2.1.300 or newer, and read access to this private repository: ask Ilja to add you. If Git Credential Manager holds several GitHub accounts, it may ask which one to use; pick the one with access.

In a Claude Code terminal session, run each of these, answering `y` to add the marketplace and choosing the user scope:

```
/plugin install session-panel --marketplace Ilja-Garbuz/claude-code-mods
/plugin install message-style --marketplace Ilja-Garbuz/claude-code-mods
/plugin install mod-manager --marketplace Ilja-Garbuz/claude-code-mods
```

Or from any shell (PowerShell, bash, fish):

```bash
claude plugin marketplace add Ilja-Garbuz/claude-code-mods
claude plugin install session-panel@ilja-mods --scope user
claude plugin install message-style@ilja-mods --scope user
claude plugin install mod-manager@ilja-mods --scope user
```

session-panel brings mod-manager along, so installing it alone also works.

Start a new session (or run `/reload-plugins`) and the panel appears once the terminal is wide enough (144 columns in the fullscreen layout). Anywhere else, type `/panel`.

To update later: `claude plugin marketplace update ilja-mods`, then `/reload-plugins`.

## Settings

- **message-style:** `/plugin configure message-style@ilja-mods` sets the panel colour and the stripe colour.
- **Turn a mod off:** use the toggles in the side panel's Mods section, `/mods toggle <name>`, or `claude plugin disable <name>@ilja-mods`.

## Notes

- **Model switching:** changing the model in the panel works like `/model`, so it also becomes your default for new sessions. Mid-session the panel warns first, because a switch drops the prompt cache.
- **Background checks:** to stay current, the panel runs `claude -p /usage --safe-mode` every 3 minutes and `claude mcp list` every 15 minutes. Neither calls the model or uses your limits.
- **Windows and Linux:** the mods call `claude` and `git` by name, so both need to be on your PATH. Nothing depends on the shell.

## Developing

See [DEVELOPMENT.md](DEVELOPMENT.md). Each mod checks with:

```bash
claude plugin validate mods/session-panel
claude plugin test mods/session-panel
```
