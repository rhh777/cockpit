import { useEffect } from 'react'
import type { TraceGroup } from '../lib/timeline'
import { ToolCallCard } from './ToolCallCard'
import { useI18n } from '../lib/i18n'

export function TraceDrawer({
  group,
  onClose,
}: {
  group: TraceGroup | null
  onClose: () => void
}) {
  const { t } = useI18n()
  // Listen for Escape key to close the drawer
  useEffect(() => {
    if (!group) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [group, onClose])

  if (!group) return null

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer-content" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div className="drawer-title-area">
            <h3>🤖 {t('trace.title')}</h3>
            <span className="drawer-subtitle">
              {t('trace.subtitle', {
                turn: group.turnId.slice(0, 12),
                thinking: group.thinkingCount,
                calls: group.callCount,
              })}
            </span>
          </div>
          <button className="drawer-close" onClick={onClose} title={t('trace.close')}>
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <div className="trace-timeline">
            {group.events.map((item, idx) => {
              const ev = item.envelope.event
              const isError = item.pair?.result?.isError

              return (
                <div key={idx} className="trace-item">
                  <div className="trace-line" />
                  
                  {ev.type === 'thinking' && (
                    <>
                      <div className="trace-node-icon icon-thinking">💡</div>
                      <div className="trace-card">
                        <div className="trace-card-title">{t('trace.thinkingStep', { index: idx + 1 })}</div>
                        <div className="trace-card-content">
                          {ev.text.trim() ? (
                            <pre className="thinking-raw-text">{ev.text}</pre>
                          ) : (
                            <div className="thinking-empty">
                              {t('trace.encryptedReasoningPre')}
                              <code>signature</code>
                              {t('trace.encryptedReasoningPost')}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {ev.type === 'tool_use' && (
                    <>
                      <div className={`trace-node-icon icon-tool ${isError ? 'has-error' : ''}`}>
                        🔧
                      </div>
                      <div className="trace-card">
                        <div className="trace-card-title">
                          {t('trace.toolCall', { index: idx + 1 })}{' '}
                          {isError && <span className="trace-badge danger">error</span>}
                        </div>
                        <div className="trace-card-content">
                          {item.pair && (
                            <ToolCallCard 
                              pair={item.pair} 
                              readOnly={item.envelope.source === 'codex'} 
                            />
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
