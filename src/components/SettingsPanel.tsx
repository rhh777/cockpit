import { useEffect, useState } from 'react'
import type { AgentModelOptionDTO, SettingsDiagnostics } from '../lib/api'
import { fetchAgentModels, fetchSettingsDiagnostics } from '../lib/api'
import { AGENT_OPTIONS, labelForAgent } from '../lib/agents'
import type { AgentName } from '../lib/types'
import { AgentPicker } from './AgentPicker'
import { AgentIcon } from './AgentIcon'
import { Icon } from './Icon'
import {
  applyThemePreference,
  applyFontSizePreference,
  readFontSizePreference,
  readAutoRefreshPreference,
  readCliSelection,
  readDefaultAgent,
  readEnabledAgents,
  readDefaultSourceFilter,
  readThemePreference,
  resetLayoutPreferences,
  setAutoRefreshPreference,
  setCliSelection,
  setDefaultAgent,
  setEnabledAgents,
  setDefaultSourceFilter,
  setFontSizePreference,
  setThemePreference,
  type CliField,
  type FontSizePreference,
  type SourceFilterPreference,
  type ThemePreference,
  PREFERENCES_CHANGED_EVENT,
} from '../lib/preferences'
import { useI18n, type LocalePreference } from '../lib/i18n'

// 只列具体模型;「CLI 默认」那一项在渲染时用 t('common.cliDefault') 前置,不在这里写死文案。
const MODEL_OPTIONS: Record<AgentName, { value: string; label: string }[]> = {
  claude: [
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  ],
  opencode: [
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet' },
    { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
    { value: 'qwen/qwen3-coder-plus', label: 'Qwen Coder' },
  ],
  cursor: [
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet' },
  ],
}

// effort 档位只存值;显示文案渲染时从 i18n 取(effortLabels),不在这里写死。
const EFFORT_VALUES: Record<AgentName, string[]> = {
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'low', 'medium', 'high', 'xhigh'],
  opencode: ['', 'low', 'medium', 'high', 'max'],
  cursor: [''],
}

function SelectRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="settings-row">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value || '__default'} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="settings-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { preference: language, setLanguagePreference: pickLanguage, t } = useI18n()
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference())
  const [fontSize, setFontSize] = useState<FontSizePreference>(() => readFontSizePreference())
  const [defaultAgent, setAgent] = useState<AgentName>(() => readDefaultAgent())
  const [enabledAgents, setEnabledAgentsState] = useState<AgentName[]>(() => readEnabledAgents())
  const [sourceFilter, setSourceFilter] = useState<SourceFilterPreference>(() => readDefaultSourceFilter())
  const [autoRefresh, setAutoRefresh] = useState(() => readAutoRefreshPreference())
  const [diagnostics, setDiagnostics] = useState<SettingsDiagnostics | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [cliRev, setCliRev] = useState(0)
  const [openCodeModels, setOpenCodeModels] = useState<AgentModelOptionDTO[] | null>(null)

  useEffect(() => applyThemePreference(theme), [theme])
  useEffect(() => applyFontSizePreference(fontSize), [fontSize])

  useEffect(() => {
    const refresh = () => {
      setEnabledAgentsState(readEnabledAgents())
      setAgent(readDefaultAgent())
    }
    window.addEventListener(PREFERENCES_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, refresh)
  }, [])

  useEffect(() => {
    let alive = true
    setDiagLoading(true)
    setDiagError(null)
    fetchSettingsDiagnostics()
      .then((d) => alive && setDiagnostics(d))
      .catch((e) => alive && setDiagError(String(e)))
      .finally(() => alive && setDiagLoading(false))
    return () => {
      alive = false
    }
  }, [refreshKey])

  useEffect(() => {
    if (defaultAgent !== 'opencode') return
    let alive = true
    fetchAgentModels('opencode')
      .then((models) => {
        if (alive) setOpenCodeModels(models.length ? models : null)
      })
      .catch(() => {
        if (alive) setOpenCodeModels(null)
      })
    return () => {
      alive = false
    }
  }, [defaultAgent, refreshKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const pickTheme = (next: ThemePreference) => {
    setTheme(next)
    setThemePreference(next)
  }

  const pickFontSize = (next: FontSizePreference) => {
    setFontSize(next)
    setFontSizePreference(next)
  }

  const pickAgent = (next: AgentName) => {
    setAgent(next)
    setDefaultAgent(next)
  }

  const toggleEnabledAgent = (agent: AgentName) => {
    const isEnabled = enabledAgents.includes(agent)
    const isAvailable = diagnostics?.agents.find((item) => item.name === agent)?.available === true
    if ((!isEnabled && !isAvailable) || (isEnabled && enabledAgents.length === 1)) return
    const next = isEnabled ? enabledAgents.filter((item) => item !== agent) : [...enabledAgents, agent]
    setEnabledAgentsState(next)
    setEnabledAgents(next)
    if (!next.includes(defaultAgent)) setAgent(next[0])
  }

  const pickSourceFilter = (next: SourceFilterPreference) => {
    setSourceFilter(next)
    setDefaultSourceFilter(next)
  }

  const pickAutoRefresh = (next: boolean) => {
    setAutoRefresh(next)
    setAutoRefreshPreference(next)
  }

  const pickCli = (agent: AgentName, field: CliField, value: string) => {
    setCliSelection(agent, field, value)
    setCliRev((n) => n + 1)
  }

  const selectedCli = readCliSelection(defaultAgent)
  void cliRev
  const selectedStatus = diagnostics?.agents.find((a) => a.name === defaultAgent)
  const baseModelOptions =
    defaultAgent === 'opencode' && openCodeModels?.length
      ? openCodeModels.map((model) => ({
          value: model.value,
          label: model.hint ? `${model.label} · ${model.hint}` : model.label,
        }))
      : MODEL_OPTIONS[defaultAgent]
  const modelOptions = [{ value: '', label: t('common.cliDefault') }, ...baseModelOptions]
  const effortLabels: Record<string, string> = {
    '': t('common.cliDefault'),
    low: t('common.low'),
    medium: t('common.medium'),
    high: t('common.high'),
    xhigh: t('common.xhigh'),
    max: t('common.max'),
  }
  const effortOptions = EFFORT_VALUES[defaultAgent].map((value) => ({
    value,
    label: effortLabels[value] ?? value,
  }))
  const agentPaths =
    defaultAgent === 'claude'
      ? [
          ['Claude projects', diagnostics?.roots.claudeProjects],
        ]
      : defaultAgent === 'codex'
      ? [
          ['Codex sessions', diagnostics?.roots.codexSessions],
          ['Codex index', diagnostics?.roots.codexIndex],
        ]
      : defaultAgent === 'opencode'
      ? [
          ['OpenCode data', diagnostics?.roots.opencodeData],
          ['OpenCode DB', diagnostics?.roots.opencodeDb],
        ]
      : []

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <section className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <div>
            <h1>{t('settings.title')}</h1>
            <p>{t('settings.subtitle')}</p>
          </div>
          <button className="head-icon-btn" onClick={onClose} title={t('common.close')}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h2>{t('settings.agents')}</h2>
            <p className="settings-section-hint">{t('settings.enabledAgentsHint')}</p>
            <div className="settings-enabled-agents" role="group" aria-label={t('settings.enabledAgents')}>
              {AGENT_OPTIONS.map((agent) => {
                const enabled = enabledAgents.includes(agent.value)
                const status = diagnostics?.agents.find((item) => item.name === agent.value)
                const canToggle = enabled ? enabledAgents.length > 1 : status?.available === true
                return (
                  <button
                    key={agent.value}
                    type="button"
                    className={`settings-enabled-agent agent-${agent.value} ${enabled ? 'active' : ''}`}
                    onClick={() => toggleEnabledAgent(agent.value)}
                    disabled={diagLoading || !canToggle}
                    aria-pressed={enabled}
                    title={
                      !status?.available && !enabled
                        ? t('settings.enableRequiresCli', { agent: agent.label })
                        : enabled && enabledAgents.length === 1
                          ? t('settings.keepOneAgent')
                          : undefined
                    }
                  >
                    <AgentIcon agent={agent.value} size={17} />
                    <span>{agent.label}</span>
                    <span className={`settings-agent-availability ${status?.available ? 'ok' : 'bad'}`}>
                      {diagLoading
                        ? t('common.detecting')
                        : status?.available
                          ? t('common.available')
                          : t('common.unavailable')}
                    </span>
                    {enabled && <Icon name="check" size={13} />}
                  </button>
                )
              })}
            </div>
            <div className="settings-row settings-default-agent-row">
              <span>{t('settings.defaultAgent')}</span>
              <AgentPicker
                value={defaultAgent}
                onChange={pickAgent}
                options={AGENT_OPTIONS.filter((option) => enabledAgents.includes(option.value))}
                className="settings-default-agent-picker"
              />
            </div>
            <div className="settings-agent-block">
              <div className="settings-agent-title">
                <span>CLI</span>
                {selectedStatus && (
                  <strong className={`settings-inline-status ${selectedStatus.available ? 'ok' : 'bad'}`}>
                    {selectedStatus.available ? t('common.available') : t('common.unavailable')}
                  </strong>
                )}
              </div>
              <SelectRow
                label={t('settings.defaultModel')}
                value={selectedCli.model ?? ''}
                onChange={(value) => pickCli(defaultAgent, 'model', value)}
                options={modelOptions}
              />
              <SelectRow
                label={t('settings.defaultReasoning')}
                value={selectedCli.effort ?? ''}
                onChange={(value) => pickCli(defaultAgent, 'effort', value)}
                options={effortOptions}
              />
              <div className="settings-diagnostic-card selectable">
                <div className="settings-diagnostic-head">
                  <span>{t('settings.detectionStatus')}</span>
                  <button className="settings-mini-btn" onClick={() => setRefreshKey((n) => n + 1)}>
                    <Icon name="rotate-ccw" size={12} /> {t('settings.retryDetection')}
                  </button>
                </div>
                {diagLoading ? (
                  <div className="settings-progress">
                    <span className="settings-progress-bar" />
                    <span>{t('settings.detectingCli', { agent: labelForAgent(defaultAgent) })}</span>
                  </div>
                ) : diagError ? (
                  <div className="settings-error">{t('settings.diagnosticsFailed', { error: diagError })}</div>
                ) : (
                  <>
                    <div className="settings-status-detail">
                      <span>CLI</span>
                      <strong className={selectedStatus?.available ? 'ok' : 'bad'}>
                        {selectedStatus?.available ? t('settings.connected') : t('settings.notDetected')}
                      </strong>
                    </div>
                    {selectedStatus?.error && <div className="settings-error">{selectedStatus.error}</div>}
                    {agentPaths.length > 0 && (
                      <div className="settings-paths compact">
                        {agentPaths.map(([key, value]) => (
                        <div key={key} className="settings-path-line">
                          <span>{key}</span>
                          <code title={value}>{value ?? t('common.detecting')}</code>
                        </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>{t('settings.interface')}</h2>
            <SelectRow
              label={t('settings.theme')}
              value={theme}
              onChange={(value) => pickTheme(value as ThemePreference)}
              options={[
                { value: 'system', label: t('settings.themeSystem') },
                { value: 'light', label: t('settings.themeLight') },
                { value: 'dark', label: t('settings.themeDark') },
              ]}
            />
            <SelectRow
              label={t('settings.language')}
              value={language}
              onChange={(value) => pickLanguage(value as LocalePreference)}
              options={[
                { value: 'system', label: t('settings.languageSystem') },
                { value: 'en', label: t('settings.languageEnglish') },
                { value: 'zh-CN', label: t('settings.languageChinese') },
              ]}
            />
            <SelectRow
              label={t('settings.fontSize')}
              value={fontSize}
              onChange={(value) => pickFontSize(value as FontSizePreference)}
              options={[
                { value: 'small', label: t('settings.fontSmall') },
                { value: 'medium', label: t('settings.fontMedium') },
                { value: 'large', label: t('settings.fontLarge') },
                { value: 'xlarge', label: t('settings.fontXLarge') },
              ]}
            />
            <SelectRow
              label={t('settings.defaultFilter')}
              value={sourceFilter}
              onChange={(value) => pickSourceFilter(value as SourceFilterPreference)}
              options={[
                { value: 'all', label: t('settings.allSessions') },
                { value: 'claude-code', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
                { value: 'opencode', label: 'OpenCode' },
              ]}
            />
            <ToggleRow label={t('settings.autoRefresh')} checked={autoRefresh} onChange={pickAutoRefresh} />
            <button className="settings-secondary-btn" onClick={resetLayoutPreferences}>
              <Icon name="rotate-ccw" size={13} /> {t('settings.resetSidebar')}
            </button>
          </section>

          <section className="settings-section">
            <h2>{t('settings.localData')}</h2>
            {diagLoading && (
              <div className="settings-progress">
                <span className="settings-progress-bar" />
                <span>{t('settings.refreshingPaths')}</span>
              </div>
            )}
            {diagnostics && (
              <div className="settings-paths selectable">
                {[
                  ['cockpit', diagnostics.roots.cockpit],
                  ['settings', diagnostics.roots.settings],
                  ['followups', diagnostics.roots.followups],
                  ['opencode db', diagnostics.roots.opencodeDb],
                ].map(([key, value]) => (
                  <div key={key} className="settings-path-line">
                    <span>{key}</span>
                    <code title={value}>{value}</code>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}
