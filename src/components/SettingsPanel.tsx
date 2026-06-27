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
            <h1>设置</h1>
            <p>本机偏好和诊断信息</p>
          </div>
          <button className="head-icon-btn" onClick={onClose} title="关闭">
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
                    {selectedStatus.available ? '可用' : '不可用'}
                  </strong>
                )}
              </div>
              <SelectRow
                label="默认模型"
                value={selectedCli.model ?? ''}
                onChange={(value) => pickCli(defaultAgent, 'model', value)}
                options={MODEL_OPTIONS[defaultAgent]}
              />
              <SelectRow
                label="默认推理"
                value={selectedCli.effort ?? ''}
                onChange={(value) => pickCli(defaultAgent, 'effort', value)}
                options={EFFORT_OPTIONS[defaultAgent]}
              />
              <div className="settings-diagnostic-card selectable">
                <div className="settings-diagnostic-head">
                  <span>检测状态</span>
                  <button className="settings-mini-btn" onClick={() => setRefreshKey((n) => n + 1)}>
                    <Icon name="rotate-ccw" size={12} /> 重新检测
                  </button>
                </div>
                {diagLoading ? (
                  <div className="settings-progress">
                    <span className="settings-progress-bar" />
                    <span>正在检测 {defaultAgent === 'claude' ? 'Claude' : 'Codex'} CLI…</span>
                  </div>
                ) : diagError ? (
                  <div className="settings-error">诊断失败:{diagError}</div>
                ) : (
                  <>
                    <div className="settings-status-detail">
                      <span>CLI</span>
                      <strong className={selectedStatus?.available ? 'ok' : 'bad'}>
                        {selectedStatus?.available ? '已连接' : '未检测到'}
                      </strong>
                    </div>
                    {selectedStatus?.error && <div className="settings-error">{selectedStatus.error}</div>}
                    <div className="settings-paths compact">
                      {agentPaths.map(([key, value]) => (
                        <div key={key} className="settings-path-line">
                          <span>{key}</span>
                          <code title={value}>{value ?? '检测中…'}</code>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>界面</h2>
            <SelectRow
              label="主题"
              value={theme}
              onChange={(value) => pickTheme(value as ThemePreference)}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
            />
            <SelectRow
              label="字体大小"
              value={fontSize}
              onChange={(value) => pickFontSize(value as FontSizePreference)}
              options={[
                { value: 'small', label: '小' },
                { value: 'medium', label: '标准' },
                { value: 'large', label: '大' },
                { value: 'xlarge', label: '更大' },
              ]}
            />
            <SelectRow
              label="默认过滤"
              value={sourceFilter}
              onChange={(value) => pickSourceFilter(value as SourceFilterPreference)}
              options={[
                { value: 'all', label: '全部 session' },
                { value: 'claude-code', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
              ]}
            />
            <ToggleRow label="打开 session 后自动刷新" checked={autoRefresh} onChange={pickAutoRefresh} />
            <button className="settings-secondary-btn" onClick={resetLayoutPreferences}>
              <Icon name="rotate-ccw" size={13} /> 重置侧栏宽度
            </button>
          </section>

          <section className="settings-section">
            <h2>本机数据</h2>
            {diagLoading && (
              <div className="settings-progress">
                <span className="settings-progress-bar" />
                <span>正在刷新本机路径…</span>
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
