import type { ToolActivity, FilterKind } from '../lib/timeline'
import { Icon } from './Icon'

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
  return (
    <div className="activity-bar">
      {onViewMode && (
        <div className="view-mode-toggle" role="tablist" aria-label="视图">
          <button
            className={`view-mode-item ${viewMode === 'narrative' ? 'active' : ''}`}
            onClick={() => onViewMode('narrative')}
            title="每 turn 一行,快速浏览"
          >叙事</button>
          <button
            className={`view-mode-item ${viewMode !== 'narrative' ? 'active' : ''}`}
            onClick={() => onViewMode('detail')}
            title="完整事件流"
          >详细</button>
        </div>
      )}
      <div className="filter-tabs">
        <button
          className={`tab-item ${filter === 'all' ? 'active' : ''}`}
          onClick={() => onFilter('all')}
        >
          全部
        </button>
        <button
          className={`tab-item ${filter === 'tools' ? 'active' : ''}`}
          onClick={() => onFilter('tools')}
        >
          工具
          {activity.callCount > 0 && (
            <span className="tab-badge">{activity.callCount}</span>
          )}
        </button>
        {activity.errorCount > 0 && (
          <button
            className={`tab-item ${filter === 'errors' ? 'active' : ''}`}
            onClick={() => onFilter('errors')}
          >
            错误
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
            title={`累计 tokens: ↑${activity.inputTokens.toLocaleString()} 输入 / ↓${activity.outputTokens.toLocaleString()} 输出`}
          >
            <Icon name="coin" size={12} /> <span>{formatTokens(activity.inputTokens + activity.outputTokens)}</span>
          </div>
        )}
        {activity.files.length > 0 && (
          onShowFiles ? (
            <button
              className="files-indicator files-indicator-btn"
              onClick={onShowFiles}
              title="查看文件热力(点击展开)"
            >
              <Icon name="folder" size={12} /> <span>{activity.files.length}</span>
            </button>
          ) : (
            <div
              className="files-indicator"
              title={`涉及文件:\n${activity.files.join('\n')}`}
            >
              <Icon name="folder" size={12} /> <span>{activity.files.length}</span>
            </div>
          )
        )}
        <div className="search-wrapper">
          <span className="search-icon"><Icon name="search" size={12} /></span>
          <input
            className="search-input-field"
            placeholder="过滤关键词..."
            value={keyword}
            onChange={(e) => onKeyword(e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}
