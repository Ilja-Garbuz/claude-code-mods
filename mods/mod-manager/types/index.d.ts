export type ModEntry = {
  id: string
  name: string
  version?: string
  scope: string
  enabled: boolean
  isMod: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mod-manager': {
      mods: ModEntry[]
      busy: string | null
      note: string | null
    }
  }
}
