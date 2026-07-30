import type { ToolActivity, FilterKind } from '../lib/timeline'
import { Icon } from './Icon'
import { useI18n } from '../lib/i18n'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return String(n)
}

export function ToolActivityBar({
  activity,
  filter,
  onFilter,
  keyword,
  onKeyword,
  onShowFiles,
  viewMode,
  onViewMode,
}: {
  activity: ToolActivity
  filter: FilterKind
  onFilter: (k: FilterKind) => void
  keyword: string
  onKeyword: (s: string) => void
  onShowFiles?: () => void
  viewMode?: 'narrative' | 'detail'
  onViewMode?: (m: 'narrative' | 'detail') => void
}) {
  const { t } = useI18n()
  return (
    <div className="activity-bar">
      {onViewMode && (
        <div className="view-mode-toggle" role="tablist" aria-label={t('toolbar.viewMode')}>
          <button
            className={`view-mode-item ${viewMode === 'narrative' ? 'active' : ''}`}
            onClick={() => onViewMode('narrative')}
            title={t('toolbar.narrativeHint')}
          >{t('toolbar.narrative')}</button>
          <button
            className={`view-mode-item ${viewMode !== 'narrative' ? 'active' : ''}`}
            onClick={() => onViewMode('detail')}
            title={t('toolbar.detailHint')}
          >{t('toolbar.detail')}</button>
        </div>
      )}
      <div className="filter-tabs">
        <button
          className={`tab-item ${filter === 'all' ? 'active' : ''}`}
          onClick={() => onFilter('all')}
        >
          {t('toolbar.all')}
        </button>
        <button
          className={`tab-item ${filter === 'tools' ? 'active' : ''}`}
          onClick={() => onFilter('tools')}
        >
          {t('toolbar.tools')}
          {activity.callCount > 0 && (
            <span className="tab-badge">{activity.callCount}</span>
          )}
        </button>
        {activity.errorCount > 0 && (
          <button
            className={`tab-item ${filter === 'errors' ? 'active' : ''}`}
            onClick={() => onFilter('errors')}
          >
            {t('toolbar.errors')}
            <span className="tab-badge danger">{activity.errorCount}</span>
          </button>
        )}
        <button
          className={`tab-item ${filter === 'thinking' ? 'active' : ''}`}
          onClick={() => onFilter('thinking')}
        >
          Thinking
        </button>
      </div>

      <div className="action-aside">
        {(activity.inputTokens > 0 || activity.outputTokens > 0) && (
          <div
            className="files-indicator"
            title={t('toolbar.tokens', {
              input: activity.inputTokens.toLocaleString(),
              output: activity.outputTokens.toLocaleString(),
            })}
          >
            <Icon name="coin" size={12} /> <span>{formatTokens(activity.inputTokens + activity.outputTokens)}</span>
          </div>
        )}
        {activity.files.length > 0 && (
          onShowFiles ? (
            <button
              className="files-indicator files-indicator-btn"
              onClick={onShowFiles}
              title={t('toolbar.fileHeat')}
            >
              <Icon name="folder" size={12} /> <span>{activity.files.length}</span>
            </button>
          ) : (
            <div
              className="files-indicator"
              title={`${t('toolbar.filesInvolved')}\n${activity.files.join('\n')}`}
            >
              <Icon name="folder" size={12} /> <span>{activity.files.length}</span>
            </div>
          )
        )}
        <div className="search-wrapper">
          <span className="search-icon"><Icon name="search" size={12} /></span>
          <input
            className="search-input-field"
            placeholder={t('toolbar.filterPlaceholder')}
            value={keyword}
            onChange={(e) => onKeyword(e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}
