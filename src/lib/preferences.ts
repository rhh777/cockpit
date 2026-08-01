import type { AgentName } from './types'

export type ThemePreference = 'system' | 'light' | 'dark'
export type LanguagePreference = 'system' | 'en' | 'zh-CN'
export type SourceFilterPreference = 'all' | 'native' | 'claude-code' | 'codex' | 'opencode' | 'cockpit'
export type FontSizePreference = 'small' | 'medium' | 'large' | 'xlarge'
export type CliField = 'model' | 'effort'
export type CliSelection = Partial<Record<CliField, string>>

export interface AppSettings {
  version: 1
  theme: ThemePreference
  language: LanguagePreference
  fontSize: FontSizePreference
  defaultAgent: AgentName
  enabledAgents: AgentName[]
  defaultSourceFilter: SourceFilterPreference
  autoRefresh: boolean
  cliByAgent: Partial<Record<AgentName, CliSelection>>
  layout: Partial<Record<'sidebarWidth' | 'reviewWidth' | 'reviewRoomWidth', number>>
}

export const STORAGE_KEYS = {
  theme: 'cockpit.theme',
  language: 'cockpit.language',
  fontSize: 'cockpit.fontSize',
  lastAgent: 'cockpit.lastAgent',
  sidebarWidth: 'cockpit.sidebarWidth',
  reviewWidth: 'cockpit.reviewWidth',
  reviewRoomWidth: 'cockpit.reviewRoomWidth',
  defaultSourceFilter: 'cockpit.defaultSourceFilter',
  autoRefresh: 'cockpit.autoRefresh',
  enabledAgents: 'cockpit.enabledAgents',
} as const

export const CLI_STORAGE_PREFIX = 'cockpit.cli.'
export const PREFERENCES_CHANGED_EVENT = 'cockpit:preferences-changed'
const KNOWN_AGENTS: AgentName[] = ['claude', 'codex', 'opencode', 'cursor']

const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  theme: 'system',
  language: 'system',
  fontSize: 'medium',
  defaultAgent: 'claude',
  enabledAgents: ['claude'],
  defaultSourceFilter: 'all',
  autoRefresh: true,
  cliByAgent: {
    claude: { effort: 'medium' },
    codex: { effort: 'medium' },
    opencode: {},
    cursor: {},
  },
  layout: {},
}

let settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
let enabledAgentsExplicit = false
let saveQueue: Promise<unknown> = Promise.resolve()

function isAgent(value: unknown): value is AgentName {
  return typeof value === 'string' && KNOWN_AGENTS.includes(value as AgentName)
}

function normalizeEnabledAgents(values: unknown): AgentName[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.filter(isAgent))]
}

function legacyValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function migrateLegacySettings(base: AppSettings): AppSettings {
  const next = structuredClone(base)
  const theme = legacyValue(STORAGE_KEYS.theme)
  if (theme === 'system' || theme === 'light' || theme === 'dark') next.theme = theme
  const language = legacyValue(STORAGE_KEYS.language)
  if (language === 'system' || language === 'en' || language === 'zh-CN') next.language = language
  const fontSize = legacyValue(STORAGE_KEYS.fontSize)
  if (fontSize === 'small' || fontSize === 'medium' || fontSize === 'large' || fontSize === 'xlarge') next.fontSize = fontSize
  const defaultAgent = legacyValue(STORAGE_KEYS.lastAgent)
  if (isAgent(defaultAgent)) next.defaultAgent = defaultAgent
  const enabledRaw = legacyValue(STORAGE_KEYS.enabledAgents)
  if (enabledRaw !== null) {
    try {
      const enabled = normalizeEnabledAgents(JSON.parse(enabledRaw))
      if (enabled.length) next.enabledAgents = enabled
      enabledAgentsExplicit = true
    } catch {
      // 损坏的旧设置忽略,后续按 CLI 检测结果初始化。
    }
  }
  if (!next.enabledAgents.includes(next.defaultAgent)) next.defaultAgent = next.enabledAgents[0]
  const filter = legacyValue(STORAGE_KEYS.defaultSourceFilter)
  if (filter === 'native' || filter === 'claude-code' || filter === 'codex' || filter === 'opencode' || filter === 'cockpit') next.defaultSourceFilter = filter
  if (legacyValue(STORAGE_KEYS.autoRefresh) === 'false') next.autoRefresh = false
  for (const agent of KNOWN_AGENTS) {
    for (const field of ['model', 'effort'] as const) {
      const value = legacyValue(`${CLI_STORAGE_PREFIX}${agent}.${field}`)
      if (value) next.cliByAgent[agent] = { ...next.cliByAgent[agent], [field]: value }
    }
  }
  for (const [field, key] of [
    ['sidebarWidth', STORAGE_KEYS.sidebarWidth],
    ['reviewWidth', STORAGE_KEYS.reviewWidth],
    ['reviewRoomWidth', STORAGE_KEYS.reviewRoomWidth],
  ] as const) {
    const value = Number(legacyValue(key))
    if (Number.isFinite(value) && value > 0) next.layout[field] = value
  }
  return next
}

function clearLegacySettings() {
  try {
    for (const key of Object.values(STORAGE_KEYS)) window.localStorage.removeItem(key)
    for (const agent of KNOWN_AGENTS) {
      for (const field of ['model', 'effort'] as const) {
        window.localStorage.removeItem(`${CLI_STORAGE_PREFIX}${agent}.${field}`)
      }
    }
  } catch {
    // 无 localStorage 的嵌入环境仍可使用服务端设置。
  }
}

function persistSettings() {
  const snapshot = structuredClone(settings)
  saveQueue = saveQueue.then(() => fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  }).then((response) => {
    if (!response.ok) throw new Error(`save settings ${response.status}`)
  })).catch((error) => console.error(error))
}

export async function hydratePreferences() {
  try {
    const response = await fetch('/api/settings')
    if (!response.ok) throw new Error(`load settings ${response.status}`)
    const payload = await response.json() as { settings?: AppSettings; persisted?: boolean }
    if (payload.settings) settings = payload.persisted ? payload.settings : migrateLegacySettings(payload.settings)
    enabledAgentsExplicit = payload.persisted === true || enabledAgentsExplicit
    if (!payload.persisted) persistSettings()
    clearLegacySettings()
  } catch (error) {
    console.error(error)
  }
}

export function readThemePreference(): ThemePreference { return settings.theme }

export function applyThemePreference(theme = readThemePreference()) {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}

export function readLanguagePreference(): LanguagePreference { return settings.language }

export function setLanguagePreference(language: LanguagePreference) {
  settings = { ...settings, language }
  persistSettings()
  notifyPreferencesChanged()
}

export function readFontSizePreference(): FontSizePreference { return settings.fontSize }

export function applyFontSizePreference(size = readFontSizePreference()) {
  document.documentElement.dataset.fontSize = size
}

export function setFontSizePreference(fontSize: FontSizePreference) {
  settings = { ...settings, fontSize }
  applyFontSizePreference(fontSize)
  persistSettings()
  notifyPreferencesChanged()
}

export function setThemePreference(theme: ThemePreference) {
  settings = { ...settings, theme }
  applyThemePreference(theme)
  persistSettings()
  notifyPreferencesChanged()
}

export function readDefaultAgent(): AgentName { return settings.defaultAgent }

export function setDefaultAgent(defaultAgent: AgentName) {
  settings = { ...settings, defaultAgent }
  persistSettings()
  notifyPreferencesChanged()
}

export function hasEnabledAgentsPreference(): boolean { return enabledAgentsExplicit }
export function readEnabledAgents(): AgentName[] { return settings.enabledAgents }

export function setEnabledAgents(agents: AgentName[]) {
  const normalized = normalizeEnabledAgents(agents)
  const enabledAgents = normalized.length ? normalized : [settings.defaultAgent]
  const defaultAgent = enabledAgents.includes(settings.defaultAgent) ? settings.defaultAgent : enabledAgents[0]
  enabledAgentsExplicit = true
  settings = { ...settings, enabledAgents, defaultAgent }
  persistSettings()
  notifyPreferencesChanged()
}

/** 首次运行按本机 CLI 检测初始化;已有用户选择时绝不覆盖。 */
export function initializeEnabledAgents(availableAgents: AgentName[]) {
  if (hasEnabledAgentsPreference()) return
  const available = normalizeEnabledAgents(availableAgents)
  setEnabledAgents(available.length ? available : [readDefaultAgent()])
}

export function readCliSelection(agent: AgentName): CliSelection {
  return { ...settings.cliByAgent[agent] }
}

export function readAllCliSelections(): Record<AgentName, CliSelection> {
  return Object.fromEntries(KNOWN_AGENTS.map((agent) => [agent, readCliSelection(agent)])) as Record<AgentName, CliSelection>
}

export function setCliSelection(agent: AgentName, field: CliField, value: string) {
  settings = { ...settings, cliByAgent: { ...settings.cliByAgent, [agent]: { ...settings.cliByAgent[agent], [field]: value } } }
  persistSettings()
  notifyPreferencesChanged()
}

export function readDefaultSourceFilter(): SourceFilterPreference { return settings.defaultSourceFilter }
export function setDefaultSourceFilter(defaultSourceFilter: SourceFilterPreference) {
  settings = { ...settings, defaultSourceFilter }
  persistSettings()
  notifyPreferencesChanged()
}

export function readAutoRefreshPreference(): boolean { return settings.autoRefresh }
export function setAutoRefreshPreference(autoRefresh: boolean) {
  settings = { ...settings, autoRefresh }
  persistSettings()
  notifyPreferencesChanged()
}

const LAYOUT_FIELDS: Record<string, keyof AppSettings['layout']> = {
  [STORAGE_KEYS.sidebarWidth]: 'sidebarWidth',
  [STORAGE_KEYS.reviewWidth]: 'reviewWidth',
  [STORAGE_KEYS.reviewRoomWidth]: 'reviewRoomWidth',
}

export function readLayoutPreference(storageKey: string): number | undefined {
  const field = LAYOUT_FIELDS[storageKey]
  return field ? settings.layout[field] : undefined
}

export function setLayoutPreference(storageKey: string, width: number) {
  const field = LAYOUT_FIELDS[storageKey]
  if (!field) return
  settings = { ...settings, layout: { ...settings.layout, [field]: width } }
  persistSettings()
}

export function resetLayoutPreferences() {
  settings = { ...settings, layout: {} }
  persistSettings()
  notifyPreferencesChanged()
}

export function notifyPreferencesChanged() {
  window.dispatchEvent(new Event(PREFERENCES_CHANGED_EVENT))
}
