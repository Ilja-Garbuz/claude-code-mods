export type PanelLimit = { kind: string; percentUsed: number; resetsAt?: string; resetsText?: string }

export type PanelUsage = {
  limits: PanelLimit[]
  tokens?: number
  window: number
  percent?: number
  costUsd?: number
  limitsAt?: number
}

export type PanelDetail = {
  model: string
  totalTokens: number
  maxTokens: number
  categories: { name: string; tokens: number; kind: string }[]
  skills: { name: string; source: string; pluginName?: string; tokens: number }[]
  servers: { name: string; tools: number }[]
  memoryFiles: { path: string; type: string; tokens: number }[]
}

export type PanelInfo = { cwd: string; version: string; branch?: string }

export type PanelBrain = { model?: string; alias?: string; effort?: string; models: string[] }

export type PanelConnector = {
  name: string
  status: 'connected' | 'auth' | 'failed' | 'pending' | 'off'
  detail?: string
}

export type PanelConnectors = { at: number; list: PanelConnector[] }

export type PanelChange = { kind: 'model' | 'effort'; value: string }

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      usage: PanelUsage | null
      detail: PanelDetail | null
      info: PanelInfo | null
      expanded: string[]
      now: number
      brain: PanelBrain
      picker: 'model' | 'effort' | null
      pending: PanelChange | null
      collapsed: boolean
      connectors: PanelConnectors | null
      checking: boolean
    }
  }
}
