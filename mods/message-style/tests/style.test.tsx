import { expect, test } from 'claude-code/testing'

type Tree = { type: string; props: { justifyContent?: string }; children: { props: { width?: number } }[] }

const prompt = (text: string) => ({
  text,
  origin: { kind: 'composer' },
  isExpanded: false,
}) as never

test('your prompt is a full-width panel with a thin stripe on the right', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  const ui = await $.ui.mount({
    plugin: 'message-style',
    surface: 'terminal',
    component: 'UserMessage',
    props: prompt('ping'),
    viewport: { columns: 120, rows: 40 },
  })
  const tree = (await ui.drawn()) as unknown as {
    children: { props: { flexGrow?: number; alignItems?: string; width?: number } }[]
  }
  expect(tree.children[0]?.props.flexGrow).toBe(1)
  expect(tree.children[0]?.props.alignItems).toBe('flex-end')
  expect(tree.children[1]?.props.width).toBe(1)
  await ui.unmount()
})

test('Claude Desktop keeps its own look', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  const ui = await $.ui.mount({ plugin: 'message-style', surface: 'desktop', component: 'UserMessage', props: prompt('ping') })
  expect(((await ui.drawn()) as unknown as Tree).type).toBe('engine')
  await ui.unmount()
})
