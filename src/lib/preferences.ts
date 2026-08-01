import type { AgentName } from './types'

export type ThemePreference = 'system' | 'light' | 'dark'
export type SourceFilterPreference = 'all' | 'native' | 'claude-code' | 'codex' | 'opencode' | 'cockpit'
export type FontSizePreference = 'small' | 'medium' | 'large' | 'xlarge'
export type CliField = 'model' | 'effort'
export type CliSelection = Partial<Record<CliField, string>>

export const STORAGE_KEYS = {
  theme: 'cockpit.theme',
  fontSize: 'cockpit.fontSize',
  lastAgent: 'cockpit.lastAgent',
  sidebarWidth: 'cockpit.sidebarWidth',
  reviewWidth: 'cockpit.reviewWidth',
  defaultSourceFilter: 'cockpit.defaultSourceFilter',
  autoRefresh: 'cockpit.autoRefresh',
  enabledAgents: 'cockpit.enabledAgents',
}

export const CLI_STORAGE_PREFIX = 'cockpit.cli.'
export const PREFERENCES_CHANGED_EVENT = 'cockpit:preferences-changed'

export function readThemePreference(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEYS.theme)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function applyThemePreference(theme = readThemePreference()) {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
}

export function readFontSizePreference(): FontSizePreference {
  const v = localStorage.getItem(STORAGE_KEYS.fontSize)
  if (v === 'small' || v === 'large' || v === 'xlarge') return v
  return 'medium'
}

export function applyFontSizePreference(size = readFontSizePreference()) {
  document.documentElement.dataset.fontSize = size
}

export function setFontSizePreference(size: FontSizePreference) {
  localStorage.setItem(STORAGE_KEYS.fontSize, size)
  applyFontSizePreference(size)
  notifyPreferencesChanged()
}

export function setThemePreference(theme: ThemePreference) {
  localStorage.setItem(STORAGE_KEYS.theme, theme)
  applyThemePreference(theme)
  notifyPreferencesChanged()
}

export function readDefaultAgent(): AgentName {
  const v = localStorage.getItem(STORAGE_KEYS.lastAgent)
  return v === 'claude' || v === 'codex' || v === 'opencode' || v === 'cursor' ? v : 'claude'
}

export function setDefaultAgent(agent: AgentName) {
  localStorage.setItem(STORAGE_KEYS.lastAgent, agent)
  notifyPreferencesChanged()
}

const KNOWN_AGENTS: AgentName[] = ['claude', 'codex', 'opencode', 'cursor']

function normalizeEnabledAgents(values: unknown): AgentName[] {
  if (!Array.isArray(values)) return []
  const known = new Set<AgentName>(KNOWN_AGENTS)
  return [...new Set(values.filter((value): value is AgentName => typeof value === 'string' && known.has(value as AgentName)))]
}

export function hasEnabledAgentsPreference(): boolean {
  return localStorage.getItem(STORAGE_KEYS.enabledAgents) !== null
}

export function readEnabledAgents(): AgentName[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.enabledAgents)
    if (raw === null) return [readDefaultAgent()]
    const agents = normalizeEnabledAgents(JSON.parse(raw))
    return agents.length ? agents : [readDefaultAgent()]
  } catch {
    return [readDefaultAgent()]
  }
}

export function setEnabledAgents(agents: AgentName[]) {
  const normalized = normalizeEnabledAgents(agents)
  const next = normalized.length ? normalized : [readDefaultAgent()]
  localStorage.setItem(STORAGE_KEYS.enabledAgents, JSON.stringify(next))
  if (!next.includes(readDefaultAgent())) setDefaultAgent(next[0])
  else notifyPreferencesChanged()
}

/** 首次运行按本机 CLI 检测初始化;已有用户选择时绝不覆盖。 */
export function initializeEnabledAgents(availableAgents: AgentName[]) {
  if (hasEnabledAgentsPreference()) return
  const available = normalizeEnabledAgents(availableAgents)
  setEnabledAgents(available.length ? available : [readDefaultAgent()])
}

export function readCliSelection(agent: AgentName): CliSelection {
  const out: CliSelection = {}
  for (const field of ['model', 'effort'] as const) {
    const v = localStorage.getItem(`${CLI_STORAGE_PREFIX}${agent}.${field}`)
    if (v) out[field] = v
  }
  return out
}

export function setCliSelection(agent: AgentName, field: CliField, value: string) {
  const key = `${CLI_STORAGE_PREFIX}${agent}.${field}`
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
  notifyPreferencesChanged()
}

export function readDefaultSourceFilter(): SourceFilterPreference {
  const v = localStorage.getItem(STORAGE_KEYS.defaultSourceFilter)
  if (v === 'native' || v === 'claude-code' || v === 'codex' || v === 'opencode' || v === 'cockpit') return v
  return 'all'
}

export function setDefaultSourceFilter(filter: SourceFilterPreference) {
  localStorage.setItem(STORAGE_KEYS.defaultSourceFilter, filter)
  notifyPreferencesChanged()
}

export function readAutoRefreshPreference(): boolean {
  return localStorage.getItem(STORAGE_KEYS.autoRefresh) !== 'false'
}

export function setAutoRefreshPreference(enabled: boolean) {
  localStorage.setItem(STORAGE_KEYS.autoRefresh, String(enabled))
  notifyPreferencesChanged()
}

export function resetLayoutPreferences() {
  localStorage.removeItem(STORAGE_KEYS.sidebarWidth)
  localStorage.removeItem(STORAGE_KEYS.reviewWidth)
  notifyPreferencesChanged()
}

export function notifyPreferencesChanged() {
  window.dispatchEvent(new Event(PREFERENCES_CHANGED_EVENT))
}
