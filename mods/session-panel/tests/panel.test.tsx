import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-panel',
  component: 'Pane',
  requestId: 'session-panel',
  props: { title: 'Session', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
} as const

test('panel draws its sections and expands one on press', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ type: 'Text', text: /USAGE LIMITS/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXT/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /LOCATION/ })).toBeDefined()
    await ui.press({ key: 'flip-skills' })
    expect(await ui.find({ key: 'flip-skills' })).toBeDefined()
    await ui.unmount()
  }
})

test('picking an effort runs /effort with it', async ($, on) => {
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  await ui.press({ key: 'pick-effort' })
  await ui.press({ key: 'opt-effort-low' })
  expect(ran).toContain('effort low')
  await ui.unmount()
})

test('collapse closes the pane and leaves a « button above the prompt', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  await pane.press({ key: 'collapse' })
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  expect(await band.find({ key: 'expand' })).toBeDefined()
  await band.press({ key: 'expand' })
  await band.redraw()
  expect(await band.find({ key: 'expand' })).toBeUndefined()
  await band.unmount()
})

test('skills and connectors expand without data yet', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  await ui.press({ key: 'flip-skills' })
  await ui.press({ key: 'flip-mcp' })
  expect(await ui.find({ key: 'check-mcp' })).toBeDefined()
  await ui.unmount()
})
