import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModEntry } from '../types'

const PANE = 'mod-manager'
const mods = atom({ plugin: 'mod-manager', key: 'mods' } as const, [] as ModEntry[])
const busy = atom({ plugin: 'mod-manager', key: 'busy' } as const, null as string | null)
const note = atom({ plugin: 'mod-manager', key: 'note' } as const, null as string | null)

type Listed = {
  id: string
  version?: string
  scope: string
  enabled: boolean
  installPath?: string
  readFromFolder?: string
}

// Scopes `claude plugin enable/disable --scope` accepts; synced and managed
// plugins are toggled without one and the CLI decides.
const SCOPES = ['user', 'project', 'local']

function runClaude($: EngineInterface, args: string[]) {
  return $.process.run(['claude', ...args], { timeoutMs: 60_000 })
}

async function hasModule($: EngineInterface, root: string | undefined) {
  if (!root) return false
  try {
    return /"modules"/.test(await $.fs.read(`${root}/hooks/hooks.json`))
  } catch {
    return false
  }
}

async function refresh($: EngineInterface) {
  const ran = await runClaude($, ['plugin', 'list', '--json'])
  if (ran.exitCode !== 0) {
    await update($, note, () => `plugin list failed: ${ran.stderr.trim().slice(0, 160)}`)
    return
  }
  const listed = JSON.parse(ran.stdout) as Listed[]
  const entries = await Promise.all(
    listed.map(async (p): Promise<ModEntry> => ({
      id: p.id,
      name: p.id.split('@')[0] ?? p.id,
      version: p.version,
      scope: p.scope,
      enabled: p.enabled,
      isMod: await hasModule($, p.readFromFolder ?? p.installPath),
    })),
  )
  entries.sort((a, b) => Number(b.isMod) - Number(a.isMod) || a.name.localeCompare(b.name))
  await update($, mods, () => entries)
}

async function toggle($: EngineInterface, id: string): Promise<string> {
  let list = await read($, mods)
  if (list.length === 0) {
    await refresh($)
    list = await read($, mods)
  }
  const entry = list.find(m => m.id === id || m.name === id)
  if (!entry) return `No installed plugin named ${id}.`
  if ((await read($, busy)) !== null) return 'Another toggle is still running.'

  await update($, busy, () => entry.id)
  try {
    const verb = entry.enabled ? 'disable' : 'enable'
    const args = ['plugin', verb, entry.id]
    if (SCOPES.includes(entry.scope)) args.push('--scope', entry.scope)
    const ran = await runClaude($, args)
    if (ran.exitCode !== 0) {
      const why = (ran.stderr || ran.stdout).trim().slice(0, 160)
      await update($, note, () => `${entry.name}: ${why}`)
      return `Could not ${verb} ${entry.name}: ${why}`
    }
    await refresh($)

    // /reload-plugins applies the change to this session. It can't run inside
    // the command that asked for it, so it runs from a timer right after; where
    // it can't run at all (a -p run), the change lands on the next start.
    $.clock.after(100, async () => {
      try {
        await $.command.run({ command: 'reload-plugins' })
        await update($, note, () => `${entry.name} ${verb}d and plugins reloaded.`)
      } catch (err) {
        $.ui.log(`reload-plugins not run: ${String(err).slice(0, 200)}`)
        await update($, note, () => `${entry.name} ${verb}d; restart Claude Code to apply it.`)
      }
    })
    const said = `${entry.name} ${verb}d; reloading plugins…`
    await update($, note, () => said)
    return said
  } finally {
    await update($, busy, () => null)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mods',
      description: 'Show installed mods and plugins with enable/disable toggles',
      argumentHint: '[toggle <plugin> | refresh]',
    })
    void refresh($)
    return next(e)
  })

  // /clear wipes the session's values; read the list again after it.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') $.clock.after(300, () => refresh($))
    return ended
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const [verb, target] = (e.args ?? '').trim().split(/\s+/)
    if (verb === 'toggle' && target) return { text: await toggle($, target) }
    await refresh($)
    if (verb === 'refresh') return { text: 'Plugin list refreshed.' }
    await $.ui.open({ id: PANE, title: 'Mods' })
    return { text: 'Mods pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, mods)
    const running = await read($, busy)
    const said = await read($, note)

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>Reading installed plugins…</Text>}
        {list.map(m => (
          <Button
            key={`toggle-${m.id}`}
            label={m.id}
            plain
            onPress={() => void toggle($, m.id)}
          >
            <Text color={m.enabled ? 'success' : 'inactive'}>
              {running === m.id ? '[ … ]' : m.enabled ? '[ on]' : '[off]'}
            </Text>{' '}
            {m.name}
            <Text dimColor>{m.isMod ? ' mod' : ''} {m.scope}</Text>
          </Button>
        ))}
        {said && <Text dimColor wrap="wrap">{said}</Text>}
      </Box>
    )
  })
}
