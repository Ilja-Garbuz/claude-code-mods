import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { PanelBrain, PanelChange, PanelConnector, PanelConnectors, PanelDetail, PanelLimit, PanelUsage } from '../types'

const PANE = 'session-panel'
const WIDTH = 44

const usage = atom({ plugin: 'session-panel', key: 'usage' } as const, null as PanelUsage | null)
const detail = atom({ plugin: 'session-panel', key: 'detail' } as const, null as PanelDetail | null)
const info = atom({ plugin: 'session-panel', key: 'info' } as const, null as { cwd: string; version: string; branch?: string } | null)
const expanded = atom({ plugin: 'session-panel', key: 'expanded' } as const, ['mods'] as string[])
const now = atom({ plugin: 'session-panel', key: 'now' } as const, 0)
const brain = atom({ plugin: 'session-panel', key: 'brain' } as const, { models: [] } as PanelBrain)
const picker = atom({ plugin: 'session-panel', key: 'picker' } as const, null as 'model' | 'effort' | null)
const collapsed = atom({ plugin: 'session-panel', key: 'collapsed' } as const, false)
const connectors = atom({ plugin: 'session-panel', key: 'connectors' } as const, null as PanelConnectors | null)
const checking = atom({ plugin: 'session-panel', key: 'checking' } as const, false)
const pending = atom({ plugin: 'session-panel', key: 'pending' } as const, null as PanelChange | null)

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// mod-manager's values, read while drawing; that plugin owns and writes them.
const mods = { plugin: 'mod-manager', key: 'mods' } as const
const modsBusy = { plugin: 'mod-manager', key: 'busy' } as const
const modsNote = { plugin: 'mod-manager', key: 'note' } as const

// The engine has no limit figures until this session's first reply; the
// figures /usage read meanwhile stand until it does.
function keepLimits(prev: PanelUsage | null, next: PanelUsage, limitsAt: number | undefined): PanelUsage {
  const limits = next.limits.length > 0 ? next.limits : (prev?.limits ?? [])
  return { ...next, limits, limitsAt }
}

function toUsage(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): PanelUsage {
  return {
    limits: u.rateLimits.map((l: SessionRateLimit) => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    tokens: u.context.tokens,
    window: u.context.window,
    percent: u.context.percent,
    costUsd: u.cost?.usd,
  }
}

const KIND_ORDER = (kind: string) => (kind === 'used' ? 0 : kind === 'buffer' ? 1 : 2)

// /usage reads the account's live figures. The engine's own
// figures only move when this session gets a reply, so another session or
// Claude Desktop can push them past what the panel last saw.
const LIVE = [
  { kind: 'five_hour', pattern: /Current session:\s*([\d.]+)%[^\n]*?resets ([^(\n]+)/ },
  { kind: 'seven_day', pattern: /Current week[^:]*:\s*([\d.]+)%[^\n]*?resets ([^(\n]+)/ },
]
const POLL_MS = 3 * 60_000

async function takeLive($: EngineInterface, text: string) {
  const found = LIVE.flatMap(({ kind, pattern }) => {
    const m = pattern.exec(text)
    return m ? [{ kind, percentUsed: Number(m[1]), resetsText: m[2]?.trim() }] : []
  })
  if (found.length === 0) return
  const at = await $.clock.now()
  await update($, usage, prev => {
    const base = prev ?? { limits: [], window: 0 }
    const limits: PanelLimit[] = found.map(f => ({ ...base.limits.find(l => l.kind === f.kind), ...f }))
    for (const l of base.limits) if (!limits.some(x => x.kind === l.kind)) limits.push(l)
    return { ...base, limits, limitsAt: at }
  })
}

// Asks a headless Claude Code for /usage. In the open session /usage is a
// dialog, so it runs apart: safe mode loads no plugins or MCP servers, and the
// command answers itself with no model call, so it costs no usage.
async function poll($: EngineInterface) {
  try {
    const ran = await $.process.run(['claude', '-p', '/usage', '--safe-mode', '--no-session-persistence'], {
      timeoutMs: 30_000,
    })
    if (ran.exitCode === 0) await takeLive($, ran.stdout)
  } catch {
    // claude not on PATH, or it took too long: the engine's figures stand
  }
}

// `claude mcp list` health-checks every configured server, the ones that
// failed or wait for a sign-in included, which the session's own tool list
// leaves out. It runs apart from the session (a few seconds) and costs no usage.
function parseMcpList(stdout: string): PanelConnector[] {
  const found: PanelConnector[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const nameEnd = line.indexOf(': ')
    const statusAt = line.lastIndexOf(' - ')
    if (nameEnd <= 0 || statusAt <= nameEnd) continue
    const name = line.slice(0, nameEnd)
    const raw = line.slice(statusAt + 3).trim()
    const status: PanelConnector['status'] = raw.includes('Connected')
      ? 'connected'
      : raw.includes('Needs authentication')
        ? 'auth'
        : raw.includes('Failed')
          ? 'failed'
          : raw.includes('Pending')
            ? 'pending'
            : 'off'
    const detail = raw.split(' — ')[1]
    found.push({ name, status, detail })
  }
  return found
}

async function checkConnectors($: EngineInterface) {
  if (await read($, checking)) return
  await update($, checking, () => true)
  try {
    const ran = await $.process.run(['claude', 'mcp', 'list'], { timeoutMs: 60_000 })
    const list = parseMcpList(ran.stdout)
    if (list.length > 0) {
      const at = await $.clock.now()
      await update($, connectors, () => ({ at, list }))
    }
  } catch {
    // claude not on PATH or the check timed out: the session's own list stands
  } finally {
    await update($, checking, () => false)
  }
}

// The breakdown is counted as /context counts it ('full': the token-count
// API, which uses none of your limits). The local estimate ran a third high
// on tool schemas. Counted at most every 10 minutes unless asked; between
// counts the Messages row follows the live total.
let countedAt = 0
const RECOUNT_MS = 10 * 60_000

async function measure($: EngineInterface, force = false) {
  const t = await $.clock.now()
  const isDue = force || t - countedAt > RECOUNT_MS
  const u = await $.session.usage(isDue ? { breakdown: 'full' } : undefined)
  await update($, usage, prev => keepLimits(prev, toUsage(u), prev?.limitsAt))
  const b = u.context.breakdown
  if (!b) return
  countedAt = t
  const servers = new Map<string, number>()
  for (const t of b.mcpTools) servers.set(t.serverName, (servers.get(t.serverName) ?? 0) + 1)
  await update($, detail, () => ({
    model: b.model,
    totalTokens: b.totalTokens,
    maxTokens: b.rawMaxTokens,
    categories: b.categories
      .filter(c => c.tokens > 0 && c.kind !== 'deferred')
      .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind }))
      // Biggest first, the compaction buffer and free space always last.
      .sort((x, y) => KIND_ORDER(x.kind) - KIND_ORDER(y.kind) || y.tokens - x.tokens),
    skills: (b.skills?.skillFrontmatter ?? [])
      .map(s => ({ name: s.name, source: s.source, pluginName: s.pluginName, tokens: s.tokens }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    servers: [...servers].map(([name, tools]) => ({ name, tools })).sort((x, y) => x.name.localeCompare(y.name)),
    memoryFiles: b.memoryFiles.map(f => ({ path: f.path, type: f.type, tokens: f.tokens })),
  }))
}

async function locate($: EngineInterface, cwd: string) {
  const { version } = await $.session.version()
  let branch: string | undefined
  try {
    const git = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5_000 })
    if (git.exitCode === 0) branch = git.stdout.trim() || undefined
  } catch {
    // no git on PATH: the panel just leaves the branch out
  }
  await update($, info, () => ({ cwd, version, branch }))
}

function kTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const CATEGORY_COLOR: Record<string, string> = {
  Messages: '#4a8ff0',
  'MCP tools': '#e8703a',
  'System tools': '#26a17b',
  'System prompt': '#d9a21b',
  Skills: '#a8a8a8',
  'MCP server instructions': '#8a8a8a',
  'Custom agents': '#b07ce8',
  'Memory files': '#e86aa6',
  'Slash commands': '#5fc4d6',
  'Autocompact buffer': '#4d4d4d',
}

const TITLE = '#d4d4d4'
// Between the terminal's black and the pane's own grey.
const PANEL_BG = '#1a1a1a'

const STATUS: Record<PanelConnector['status'], { mark: string; color: string; word: string; rank: number }> = {
  connected: { mark: '●', color: '#4ade80', word: 'connected', rank: 0 },
  auth: { mark: '●', color: '#facc15', word: 'needs sign-in', rank: 1 },
  pending: { mark: '●', color: '#facc15', word: 'needs approval', rank: 1 },
  failed: { mark: '●', color: '#ef4444', word: 'failed', rank: 2 },
  off: { mark: '○', color: '#6b6b6b', word: 'not set up', rank: 3 },
}

const SOURCE_LABEL: Record<string, string> = {
  userSettings: 'your skills',
  projectSettings: 'this project',
  'built-in': 'built in',
  bundled: 'built in',
  mcp: 'from connectors',
  syncedSkills: 'synced',
}

// "claude.ai Gmail" reads Gmail; "plugin:engineering:slack" reads slack · engineering.
function labelOf(name: string) {
  if (name.startsWith('claude.ai ')) return name.slice('claude.ai '.length)
  const parts = name.split(':')
  if (parts[0] === 'plugin' && parts.length >= 3) {
    return parts[1] === parts[2] ? parts[2]! : `${parts.slice(2).join(':')} · ${parts[1]}`
  }
  return name
}

const colorOf = (name: string) => CATEGORY_COLOR[name] ?? '#7a7a7a'

function ago(at: number | undefined, now: number) {
  if (!at) return ''
  const mins = Math.floor((now - at) / 60_000)
  return mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`
}

// Green at 0%, yellow at 50%, red at 100%.
const STOPS: [number, number, number][] = [[74, 222, 128], [250, 204, 21], [239, 68, 68]]

function gradient(fraction: number) {
  const t = Math.max(0, Math.min(1, fraction)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(t))
  const a = STOPS[i]!
  const b = STOPS[i + 1]!
  const mix = (k: number) => Math.round(a[k]! + (b[k]! - a[k]!) * (t - i))
  return `#${[0, 1, 2].map(k => mix(k).toString(16).padStart(2, '0')).join('')}`
}

// A thin bar: each filled cell takes the gradient's colour at its own place,
// so a fuller bar runs further into yellow and red.
function cellsOf(percent: number, cells: number) {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return {
    on: Array.from({ length: filled }, (_, i) => gradient(cells === 1 ? 0 : i / (cells - 1))),
    off: cells - filled,
  }
}

function untilReset(resetsAt: string | undefined, at: number) {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - at
  if (!(ms > 0)) return 'resetting'
  const mins = Math.round(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5-HOUR', seven_day: 'WEEKLY', spend_limit: 'SPEND' }

function shorten(path: string, room: number) {
  return path.length <= room ? path : `…${path.slice(path.length - room + 1)}`
}

async function readBrain($: EngineInterface) {
  const row = (await $.config.list()).find(r => r.key === 'model')
  const settings = (await $.settings.read()) as {
    modelSettings?: Record<string, { effortLevel?: string }>
    effortLevel?: string
  }
  const alias = typeof row?.value === 'string' ? row.value : undefined
  await update($, brain, b => {
    // Effort is kept per model id (claude-opus-5-5); before the first request
    // names the id, take the entry whose id holds the alias (opus).
    const perModel = settings.modelSettings ?? {}
    const key = b.model ?? Object.keys(perModel).find(id => alias && id.includes(alias.replace(/\[.*\]$/, '')))
    const fromSettings = (key && perModel[key]?.effortLevel) || settings.effortLevel
    return {
      ...b,
      alias: alias ?? b.alias,
      models: (row?.options ?? []).filter(m => m !== 'default'),
      effort: b.effort ?? fromSettings,
    }
  })
}

// /model and /effort do the switch, as typing them would.
async function apply($: EngineInterface, change: PanelChange) {
  await update($, pending, () => null)
  await update($, picker, () => null)
  try {
    await $.command.run({ command: change.kind, args: change.value })
    await update($, brain, b =>
      change.kind === 'model' ? { ...b, alias: change.value } : { ...b, effort: change.value },
    )
    $.ui.toast(`${change.kind === 'model' ? 'Model' : 'Effort'} set to ${change.value}`)
  } catch (err) {
    $.ui.toast(`Could not change ${change.kind}: ${String(err).slice(0, 120)}`)
  }
  void readBrain($).catch(() => undefined)
}

// Collapsed, the pane is closed and gives its room back to the transcript;
// a single « button above the prompt brings it back. (A docked pane keeps a
// minimum width, so a thin strip was not possible.)
async function setCollapsed($: EngineInterface, isCollapsed: boolean) {
  await update($, collapsed, () => isCollapsed)
  if (isCollapsed) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: 'Session', columns: WIDTH })
}

export const register: Register = on => {
  // Opened unasked at start, the panel stays only where it docks beside the
  // transcript; /panel opens it anywhere, inline above the prompt included.
  let isAsked = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'panel',
      description: 'Open the session side panel (limits, context, skills, connectors, mods)',
    })
    const started = await next(e)
    void locate($, e.cwd)
    void measure($, true)
    void readBrain($).catch(() => undefined)
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    // Redraw the reset countdowns once a minute.
    // Once a minute: redraw the countdowns, and take the engine's latest
    // limit figures (a free read; they move whenever any request answers).
    $.clock.every(60_000, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
    })
    if (e.isInteractive) {
      $.clock.after(2_000, () => poll($))
      $.clock.every(POLL_MS, () => poll($))
      $.clock.after(5_000, () => checkConnectors($))
      $.clock.every(15 * 60_000, () => checkConnectors($))
    }
    if (e.isInteractive && e.surface === 'terminal') {
      if (!(await read($, collapsed))) void $.ui.open({ id: PANE, title: 'Session', columns: WIDTH })
    }
    return started
  })

  // /clear wipes the session's values and starts no new session.start, so
  // the panel fills itself again once the clear has gone through.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      $.clock.after(300, async () => {
        void locate($, await $.session.cwd())
        void measure($, true)
        void readBrain($).catch(() => undefined)
        void poll($)
        void checkConnectors($)
        const t = await $.clock.now()
        await update($, now, () => t)
      })
    }
    return ended
  })

  on('session.measure', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, usage, prev => keepLimits(prev, toUsage(e), e.rateLimits.length > 0 ? at : prev?.limitsAt))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) void measure($)
    return done
  })

  // The live model and effort, as each main-loop request is sent.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      // A request without an effort keeps the one already known.
      const effort = e.effort === undefined ? undefined : String(e.effort)
      void update($, brain, b =>
        b.model === e.model && (effort === undefined || b.effort === effort)
          ? b
          : { ...b, model: e.model, effort: effort ?? b.effort },
      )
    }
    return yield* next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    isAsked = true
    void measure($, true)
    await setCollapsed($, false)
    return { text: 'Session panel opened.' }
  })

  // The close mark collapses the panel: it goes, and the « button stays.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, collapsed, () => true)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt', surface: 'terminal' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, collapsed))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box justifyContent="flex-end">
        <Button key="expand" label="open session panel" plain onPress={() => void setCollapsed($, false)}>
          <Text color={TITLE}>«</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (e.props.placement === 'inline' && !isAsked) {
      $.clock.after(0, () => $.ui.close({ id: PANE }))
      return <Text dimColor>Session panel: type /panel to keep it open here</Text>
    }
    // Two cells clear of the pane's right edge, so the percentages never touch it.
    const cols = Math.max(22, e.props.bodyColumns - 2)
    const u = await read($, usage)
    const counted = await read($, detail)
    // Between counts, the Messages row is the live total less everything else.
    const d =
      counted && u?.tokens !== undefined
        ? {
            ...counted,
            categories: counted.categories.map(c => {
              if (c.name !== 'Messages') return c
              const rest = counted.categories
                .filter(x => x.kind === 'used' && x.name !== 'Messages')
                .reduce((n, x) => n + x.tokens, 0)
              return { ...c, tokens: Math.max(c.tokens, (u.tokens ?? 0) - rest) }
            }),
          }
        : counted
    const where = await read($, info)
    const open = await read($, expanded)
    const at = (await read($, now)) || Date.now()
    const mind = await read($, brain)
    const choosing = await read($, picker)
    const asked = await read($, pending)
    const { value: modList = [] } = await $.state.get(mods)
    const { value: busyId = null } = await $.state.get(modsBusy)
    const { value: said = null } = await $.state.get(modsNote)

    const isOpen = (k: string) => open.includes(k)
    const flip = (k: string) => () =>
      void update($, expanded, list => (list.includes(k) ? list.filter(x => x !== k) : [...list, k]))

    const heading = (title: string, k?: string, count?: number | string) => (
      <Box marginTop={1}>
        <Text bold color={TITLE}>{title}</Text>
        {count !== undefined && <Text dimColor> ({count})</Text>}
        {k && <Text> </Text>}
        {k && (
          <Button key={`flip-${k}`} label={isOpen(k) ? 'hide' : 'show'} plain onPress={flip(k)}>
            <Text dimColor>{isOpen(k) ? '[−]' : '[+]'}</Text>
          </Button>
        )}
      </Box>
    )

    const limits = u?.limits ?? []
    // Before the first reply there is no live figure: count what is loaded
    // (the used rows), never the tools that load on demand.
    const loaded = d ? d.categories.filter(c => c.kind === 'used').reduce((n, c) => n + c.tokens, 0) : undefined
    const ctxTokens = u?.tokens ?? loaded
    const ctxPercent = u?.percent ?? (d && loaded !== undefined ? Math.round((loaded / d.maxTokens) * 100) : 0)

    const thinBar = (k: string, percent: number) => {
      const c = cellsOf(percent, cols)
      return (
        <Box key={`bar-${k}`}>
          {c.on.map((color, i) => (
            <Text key={`${k}-${i}`} color={color}>━</Text>
          ))}
          <Text color="#3a3a3a">{'─'.repeat(c.off)}</Text>
        </Box>
      )
    }

    // Limits as Claude Desktop's usage pane draws them: a thick bar, blue,
    // turning red from 80% used, on a dark track.
    const limitBar = (k: string, percent: number) => {
      const filled = Math.max(0, Math.min(cols, Math.round((percent / 100) * cols)))
      return (
        <Box key={`bar-${k}`}>
          <Text color={percent >= 80 ? '#e5484d' : '#4a8ff0'}>{'▆'.repeat(filled)}</Text>
          <Text color="#3a3a3a">{'▆'.repeat(cols - filled)}</Text>
        </Box>
      )
    }

    const mcp = await read($, connectors)
    const isChecking = await read($, checking)
    // The session names a server in tool spelling (claude_ai_Gmail), the
    // check in display spelling (claude.ai Gmail): compare letters and digits.
    const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
    const toolCount = new Map((d?.servers ?? []).map(x => [keyOf(x.name), x.tools]))
    const connectorRows = (
      mcp
        ? mcp.list.map(c => ({ ...c, tools: toolCount.get(keyOf(c.name)) }))
        : (d?.servers ?? []).map(x => ({ name: x.name, status: 'connected' as const, detail: undefined, tools: x.tools }))
    )
      .map(c => ({ ...c, label: labelOf(c.name) }))
      .sort((x, y) => STATUS[x.status].rank - STATUS[y.status].rank || x.label.localeCompare(y.label))

    const groups = new Map<string, NonNullable<typeof d>['skills']>()
    for (const sk of d?.skills ?? []) {
      const group = sk.pluginName ?? SOURCE_LABEL[sk.source] ?? sk.source
      groups.set(group, [...(groups.get(group) ?? []), sk])
    }
    const skillGroups = [...groups].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))

    const segmentBar = () => {
      if (!d) return null
      const used = d.categories.filter(c => c.kind !== 'free')
      let left = cols
      const runs = used.map(c => {
        const n = Math.min(left, Math.max(1, Math.round((c.tokens / d.maxTokens) * cols)))
        left -= n
        return { name: c.name, n }
      })
      return (
        <Box key="bar-context">
          {runs.filter(r => r.n > 0).map(r => (
            <Text key={`seg-${r.name}`} color={colorOf(r.name)}>{'━'.repeat(r.n)}</Text>
          ))}
          <Text color="#3a3a3a">{'─'.repeat(Math.max(0, left))}</Text>
        </Box>
      )
    }

    // With context in the cache, a switch asks first: it drops the cache.
    const choose = (change: PanelChange) => () =>
      void ((ctxTokens ?? 0) > 0 ? update($, pending, () => change) : apply($, change))
    const options = choosing === 'model' ? mind.models : choosing === 'effort' ? EFFORTS : []
    const current = choosing === 'model' ? mind.alias : mind.effort
    const togglePicker = (k: 'model' | 'effort') => () => void update($, picker, p => (p === k ? null : k))

    return (
      // The collapse button sits at the foot of the panel: pinned to the
      // bottom while the sections are shorter than the pane, after them when
      // they run longer.
      <Box
        flexDirection="column"
        width={e.props.bodyColumns}
        paddingRight={Math.max(0, e.props.bodyColumns - cols)}
        minHeight={e.props.scroll.bodyRows}
        justifyContent="space-between"
        backgroundColor={PANEL_BG}
      >
        <Box flexDirection="column">
        {limits.length === 0 && (
          <Box flexDirection="column">
            <Text bold color={TITLE}>USAGE LIMITS</Text>
            <Text dimColor>No reading yet (shows after the first reply on a subscription)</Text>
          </Box>
        )}
        {limits.map((l, i) => (
          <Box key={`limit-${l.kind}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
            <Box justifyContent="space-between">
              <Text bold color={TITLE}>{LIMIT_LABEL[l.kind] ?? l.kind.toUpperCase()}</Text>
              <Text dimColor>{Math.round(l.percentUsed)}% used</Text>
            </Box>
            {limitBar(l.kind, l.percentUsed)}
            <Text dimColor>
              {l.resetsAt ? `resets in ${untilReset(l.resetsAt, at)}` : l.resetsText ? `resets ${l.resetsText}` : ' '}
              {u?.limitsAt ? ` · read ${ago(u.limitsAt, at)}` : ''}
            </Text>
          </Box>
        ))}

        {heading('CONTEXT', 'context')}
        {d ? segmentBar() : thinBar('context', ctxPercent)}
        <Text>
          {ctxTokens !== undefined ? kTokens(ctxTokens) : '—'} / {kTokens(u?.window ?? d?.maxTokens ?? 0)}
          <Text dimColor> ({ctxPercent}% used{u?.costUsd !== undefined ? `, $${u.costUsd.toFixed(2)}` : ''})</Text>
        </Text>
        {isOpen('context') && d && (
          <Box flexDirection="column">
            {d.categories.map(c => (
              <Box key={`cat-${c.name}`} justifyContent="space-between">
                <Text wrap="truncate-end">
                  <Text color={c.kind === 'free' ? '#3a3a3a' : colorOf(c.name)}>■ </Text>
                  <Text dimColor={c.kind !== 'used'}>{c.name}</Text>
                </Text>
                <Text dimColor>
                  {kTokens(c.tokens)} {String(((c.tokens / d.maxTokens) * 100).toFixed(1)).padStart(5)}%
                </Text>
              </Box>
            ))}
            {d.memoryFiles.length > 0 && <Text dimColor>memory files: {d.memoryFiles.length}</Text>}
          </Box>
        )}

        {heading('MODEL')}
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            {mind.model ?? d?.model ?? '—'}
            {mind.alias && <Text dimColor> ({mind.alias})</Text>}
          </Text>
          <Button key="pick-model" label="change model" plain onPress={togglePicker('model')}>
            <Text dimColor>[change]</Text>
          </Button>
        </Box>
        <Box justifyContent="space-between">
          <Text>
            effort{' '}
            {mind.effort ? <Text bold>{mind.effort}</Text> : <Text dimColor>default</Text>}
          </Text>
          <Button key="pick-effort" label="change effort" plain onPress={togglePicker('effort')}>
            <Text dimColor>[change]</Text>
          </Button>
        </Box>
        {choosing && !asked && (
          <Box flexWrap="wrap" columnGap={1}>
            {options.map(o => (
              <Button key={`opt-${choosing}-${o}`} label={o} plain onPress={choose({ kind: choosing, value: o })}>
                <Text color={o === current ? 'success' : undefined}>{o === current ? `[${o}]` : o}</Text>
              </Button>
            ))}
          </Box>
        )}
        {asked && (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" wrap="wrap">
              Switching {asked.kind} to {asked.value} now drops the prompt cache. Your next message re-sends all{' '}
              {ctxTokens !== undefined ? kTokens(ctxTokens) : ''} tokens of context uncached, so it costs more and uses
              more of your limits.
            </Text>
            <Box columnGap={2}>
              <Button key="confirm-change" label="switch anyway" variant="primary" onPress={() => void apply($, asked)} />
              <Button key="cancel-change" label="cancel" onPress={() => void update($, pending, () => null)} />
            </Box>
          </Box>
        )}

        {heading('SKILLS', 'skills', d ? `${d.skills.length} · ${kTokens(d.skills.reduce((n, x) => n + x.tokens, 0))}` : undefined)}
        {isOpen('skills') &&
          skillGroups.map(([group, list]) => (
            <Box key={`sg-${group}`} flexDirection="column">
              <Text dimColor>{group}</Text>
              {list.map(sk => (
                <Box key={`skill-${group}-${sk.name}`} justifyContent="space-between">
                  <Text wrap="truncate-end">  {sk.name}</Text>
                  <Text dimColor>{kTokens(sk.tokens)}</Text>
                </Box>
              ))}
            </Box>
          ))}

        <Box marginTop={1} justifyContent="space-between">
          <Box>
            <Text bold color={TITLE}>CONNECTORS</Text>
            <Text dimColor>
              {' '}
              ({mcp ? `${mcp.list.filter(c => c.status === 'connected').length}/${mcp.list.length}` : d?.servers.length ?? '…'})
            </Text>
            <Text> </Text>
            <Button key="flip-mcp" label={isOpen('mcp') ? 'hide' : 'show'} plain onPress={flip('mcp')}>
              <Text dimColor>{isOpen('mcp') ? '[−]' : '[+]'}</Text>
            </Button>
          </Box>
          <Button key="check-mcp" label="check connectors again" plain onPress={() => void checkConnectors($)}>
            <Text dimColor>{isChecking ? 'checking…' : '↻'}</Text>
          </Button>
        </Box>
        {isOpen('mcp') &&
          connectorRows.map(c => (
            <Box key={`mcp-${c.name}`} justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text color={STATUS[c.status].color}>{c.status === 'connected' && !c.tools ? '○' : STATUS[c.status].mark} </Text>
                <Text dimColor={c.status === 'off'}>{c.label}</Text>
              </Text>
              <Text dimColor>{c.tools ? `${c.tools} tools` : c.status === 'connected' ? 'no tools here' : STATUS[c.status].word}</Text>
            </Box>
          ))}
        {isOpen('mcp') && mcp && <Text dimColor>checked {ago(mcp.at, at)}</Text>}

        {heading('LOCATION')}
        <Text wrap="truncate-start">{where ? shorten(where.cwd, cols) : '—'}</Text>
        {where?.branch && <Text dimColor>branch {where.branch}</Text>}

        {heading('CLAUDE CODE')}
        <Text>v{where?.version ?? '?'}</Text>

        {heading('MODS', 'mods', modList.filter(m => m.isMod).length)}
        {isOpen('mods') && modList.length === 0 && (
          <Text dimColor>Install mod-manager to toggle mods here</Text>
        )}
        {isOpen('mods') &&
          modList
            .filter(m => m.isMod)
            .map(m => (
              <Button
                key={`mod-${m.id}`}
                label={m.id}
                plain
                onPress={() => void $.command.run({ command: 'mods', args: `toggle ${m.id}` })}
              >
                <Text color={m.enabled ? 'success' : 'inactive'}>
                  {busyId === m.id ? '[ … ]' : m.enabled ? '[ on]' : '[off]'}
                </Text>{' '}
                {m.name}
              </Button>
            ))}
        {isOpen('mods') && said && <Text dimColor wrap="wrap">{said}</Text>}
        </Box>
        <Box marginTop={1}>
          <Button key="collapse" label="collapse panel" plain onPress={() => void setCollapsed($, true)}>
            <Text dimColor>» collapse</Text>
          </Button>
        </Box>
      </Box>
    )
  })
}
