# Developing the mods

README.md covers what each mod does and how to install it. This file is for working on the mods themselves.

## Working from a local clone

- Add your clone as a local marketplace and install the mods from it: `claude plugin marketplace add <path to your clone>`, then `claude plugin install <mod>@ilja-mods --scope user`. The marketplace is read straight from the clone, so edits apply after `/reload-plugins`.
- Check a mod with `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`. Type-check with TypeScript against the API declarations that the plugin-authoring skill writes (the tsconfig shape is in that file's header).
- Test in a terminal: run `claude` there and read its output. The mods only change the terminal UI.

## Decisions and findings

- **session-panel:** it docks by itself only in the fullscreen layout at 144+ columns. If it opens inline without being asked, it closes itself; `/panel` opens it anywhere. Data comes from `$.session.usage({ breakdown: 'full' })` (the summary estimate overcounts tool schemas by about a third; full is recounted at most every 10 minutes), which gives limits, context, skills, MCP tools and memory files. The Mods section reads mod-manager's `$.state` values and toggles through `/mods toggle <id>`.
- **message-style (v0.3):** terminal only. Prompts are drawn from their text as a full-width panel (padding, right-aligned text) with a half-cell stripe on the right: an absolutely positioned, overflow-hidden column of `▐`, so it never adds rows. An engine node can't sit under a Box with `width`, so the engine's own row can't be restyled. Settings: `bubbleColor`, `stripeColor`.
- **session-panel limits:** the engine only updates limits on this session's own replies, so the panel runs `claude -p /usage --safe-mode --no-session-persistence` every 3 minutes, and after `/clear`, and parses its text. That copy loads no plugins and makes no model call. In an open session, `/usage` is a dialog, so it must never be run there.
- **session-panel look:** section titles are light grey. The limit bars use Desktop's style: thick, blue, red from 80%. The context bar is split by category colour, sorted biggest first. The ✕ and "» collapse" close the pane and leave a « button in the AbovePrompt band, because a docked pane has a minimum width. After `/clear` the panel refills from a `session.end` hook with reason `clear`.
- **session-panel model/effort:** the live values come from `turn.step`. Changes run `/model <alias>` or `/effort <level>` through `$.command.run` from the press handler. With context in the cache, a warning box asks for confirmation first.
- **mod-manager:** lists plugins with `claude plugin list --json` and marks a plugin as a mod when its `hooks/hooks.json` has `modules`. It toggles with `claude plugin enable/disable --scope`. `/reload-plugins` cannot run inside a `command.run` hook, so it runs from `$.clock.after(100)`. Live toggling was verified: the disabled mod unloads in the same session.

## Releasing

- A release means bumping the mod's `version` in its `plugin.json` and pushing to `main`. Users then run `claude plugin marketplace update ilja-mods` followed by `/reload-plugins`.
- Commit messages carry no `Co-Authored-By` or "Generated with" lines.
