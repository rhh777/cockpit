import fs from 'node:fs/promises'
import path from 'node:path'
import { COCKPIT_SETTINGS_PATH } from '../config'
import type { AgentName } from '../loaders/types'

export type ThemePreference = 'system' | 'light' | 'dark'
export type LanguagePreference = 'system' | 'en' | 'zh-CN'
export type FontSizePreference = 'small' | 'medium' | 'large' | 'xlarge'
export type SourceFilterPreference = 'all' | 'native' | 'claude-code' | 'codex' | 'opencode' | 'cursor' | 'cockpit'

export interface AppSettings {
  version: 1
  theme: ThemePreference
  language: LanguagePreference
  fontSize: FontSizePreference
  defaultAgent: AgentName
  enabledAgents: AgentName[]
  defaultSourceFilter: SourceFilterPreference
  autoRefresh: boolean
  cliByAgent: Partial<Record<AgentName, { model?: string; effort?: string }>>
  layout: {
    sidebarWidth?: number
    reviewWidth?: number
    reviewRoomWidth?: number
  }
}

const AGENTS: AgentName[] = ['claude', 'codex', 'opencode', 'cursor']
const THEMES = new Set(['system', 'light', 'dark'])
const LANGUAGES = new Set(['system', 'en', 'zh-CN'])
const FONT_SIZES = new Set(['small', 'medium', 'large', 'xlarge'])
const FILTERS = new Set(['all', 'native', 'claude-code', 'codex', 'opencode', 'cursor', 'cockpit'])

export const DEFAULT_APP_SETTINGS: AppSettings = {
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

function enumValue<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? value as T : fallback
}

function normalizeAgents(value: unknown, fallback: AgentName[]): AgentName[] {
  if (!Array.isArray(value)) return fallback
  const allowed = new Set<AgentName>(AGENTS)
  const agents = [...new Set(value.filter((item): item is AgentName => typeof item === 'string' && allowed.has(item as AgentName)))]
  return agents.length ? agents : fallback
}

function normalizeCli(value: unknown): AppSettings['cliByAgent'] {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const output: AppSettings['cliByAgent'] = {}
  for (const agent of AGENTS) {
    const raw = input[agent]
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    output[agent] = {
      ...(typeof entry.model === 'string' ? { model: entry.model.trim() } : {}),
      ...(typeof entry.effort === 'string' ? { effort: entry.effort.trim() } : {}),
    }
  }
  return output
}

function finiteWidth(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const enabledAgents = normalizeAgents(input.enabledAgents, DEFAULT_APP_SETTINGS.enabledAgents)
  const requestedDefault = enumValue(input.defaultAgent, new Set(AGENTS), DEFAULT_APP_SETTINGS.defaultAgent)
  const defaultAgent = enabledAgents.includes(requestedDefault) ? requestedDefault : enabledAgents[0]
  const layout = input.layout && typeof input.layout === 'object' ? input.layout as Record<string, unknown> : {}
  return {
    version: 1,
    theme: enumValue(input.theme, THEMES, DEFAULT_APP_SETTINGS.theme),
    language: enumValue(input.language, LANGUAGES, DEFAULT_APP_SETTINGS.language),
    fontSize: enumValue(input.fontSize, FONT_SIZES, DEFAULT_APP_SETTINGS.fontSize),
    defaultAgent,
    enabledAgents,
    defaultSourceFilter: enumValue(input.defaultSourceFilter, FILTERS, DEFAULT_APP_SETTINGS.defaultSourceFilter),
    autoRefresh: typeof input.autoRefresh === 'boolean' ? input.autoRefresh : DEFAULT_APP_SETTINGS.autoRefresh,
    cliByAgent: { ...DEFAULT_APP_SETTINGS.cliByAgent, ...normalizeCli(input.cliByAgent) },
    layout: {
      ...(finiteWidth(layout.sidebarWidth) ? { sidebarWidth: finiteWidth(layout.sidebarWidth) } : {}),
      ...(finiteWidth(layout.reviewWidth) ? { reviewWidth: finiteWidth(layout.reviewWidth) } : {}),
      ...(finiteWidth(layout.reviewRoomWidth) ? { reviewRoomWidth: finiteWidth(layout.reviewRoomWidth) } : {}),
    },
  }
}

export class SettingsStore {
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly filePath = COCKPIT_SETTINGS_PATH) {}

  async read(): Promise<{ settings: AppSettings; persisted: boolean }> {
    await this.writes
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      return { settings: normalizeAppSettings(JSON.parse(raw)), persisted: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { settings: structuredClone(DEFAULT_APP_SETTINGS), persisted: false }
      }
      throw error
    }
  }

  async write(value: unknown): Promise<AppSettings> {
    const settings = normalizeAppSettings(value)
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporary, this.filePath)
    }
    this.writes = this.writes.then(write, write)
    await this.writes
    return settings
  }

  async cliDefaults(agent: AgentName): Promise<{ model?: string; effort?: string }> {
    const { settings } = await this.read()
    const selected = settings.cliByAgent[agent] ?? {}
    return {
      ...(selected.model ? { model: selected.model } : {}),
      ...(selected.effort ? { effort: selected.effort } : {}),
    }
  }
}

export const settingsStore = new SettingsStore()
