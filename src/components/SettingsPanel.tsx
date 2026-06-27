import { useEffect, useState } from 'react'
import type { SettingsDiagnostics } from '../lib/api'
import { fetchSettingsDiagnostics } from '../lib/api'
import type { AgentName } from '../lib/types'
import { AgentIcon } from './AgentIcon'
import { Icon } from './Icon'
import {
  applyThemePreference,
  applyFontSizePreference,
  readFontSizePreference,
  readAutoRefreshPreference,
  readCliSelection,
  readDefaultAgent,
  readDefaultSourceFilter,
  readThemePreference,
  resetLayoutPreferences,
  setAutoRefreshPreference,
  setCliSelection,
  setDefaultAgent,
  setDefaultSourceFilter,
  setFontSizePreference,
  setThemePreference,
  type CliField,
  type FontSizePreference,
  type SourceFilterPreference,
  type ThemePreference,
} from '../lib/preferences'
import { useI18n, type LocalePreference } from '../lib/i18n'

const MODEL_OPTIONS: Record<AgentName, { value: string; label: string }[]> = {
  claude: [
    { value: '', label: 'CLI 默认' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  codex: [
    { value: '', label: 'CLI 默认' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  ],
}

const EFFORT_OPTIONS: Record<AgentName, { value: string; label: string }[]> = {
  claude: [
    { value: '', label: 'CLI 默认' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '超高' },
    { value: 'max', label: '极致' },
  ],
  codex: [
    { value: '', label: 'CLI 默认' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' },
    { value: 'xhigh', label: '超高' },
  ],
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
  const [sourceFilter, setSourceFilter] = useState<SourceFilterPreference>(() => readDefaultSourceFilter())
  const [autoRefresh, setAutoRefresh] = useState(() => readAutoRefreshPreference())
  const [diagnostics, setDiagnostics] = useState<SettingsDiagnostics | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [cliRev, setCliRev] = useState(0)

  useEffect(() => applyThemePreference(theme), [theme])
  useEffect(() => applyFontSizePreference(fontSize), [fontSize])

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
  const modelOptions = MODEL_OPTIONS[defaultAgent].map((option) =>
    option.value ? option : { ...option, label: t('common.cliDefault') },
  )
  const effortLabels: Record<string, string> = {
    '': t('common.cliDefault'),
    low: t('common.low'),
    medium: t('common.medium'),
    high: t('common.high'),
    xhigh: t('common.xhigh'),
    max: t('common.max'),
  }
  const effortOptions = EFFORT_OPTIONS[defaultAgent].map((option) => ({
    ...option,
    label: effortLabels[option.value] ?? option.label,
  }))
  const agentPaths =
    defaultAgent === 'claude'
      ? [
          ['Claude projects', diagnostics?.roots.claudeProjects],
        ]
      : [
          ['Codex sessions', diagnostics?.roots.codexSessions],
          ['Codex index', diagnostics?.roots.codexIndex],
        ]

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
            <h2>Agent</h2>
            <div className="settings-segment">
              {(['claude', 'codex'] as AgentName[]).map((agent) => (
                <button
                  key={agent}
                  className={`settings-segment-item agent-${agent} ${defaultAgent === agent ? 'active' : ''}`}
                  onClick={() => pickAgent(agent)}
                >
                  <AgentIcon agent={agent} size={16} />
                  {agent === 'claude' ? 'Claude' : 'Codex'}
                </button>
              ))}
            </div>
            <div className="settings-agent-block">
              <div className="settings-agent-title">
                <AgentIcon agent={defaultAgent} size={16} />
                {defaultAgent === 'claude' ? 'Claude CLI' : 'Codex CLI'}
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
                    <span>{t('settings.detectingCli', { agent: defaultAgent === 'claude' ? 'Claude' : 'Codex' })}</span>
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
                    <div className="settings-paths compact">
                      {agentPaths.map(([key, value]) => (
                        <div key={key} className="settings-path-line">
                          <span>{key}</span>
                          <code title={value}>{value ?? t('common.detecting')}</code>
                        </div>
                      ))}
                    </div>
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
                  ['followups', diagnostics.roots.followups],
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
