import { useEffect } from 'react'
import type { TraceGroup } from '../lib/timeline'
import { ToolCallCard } from './ToolCallCard'

export function TraceDrawer({
  group,
  onClose,
}: {
  group: TraceGroup | null
  onClose: () => void
}) {
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
            <h3>🤖 Agent 执行细节与思维轨迹</h3>
            <span className="drawer-subtitle">
              轮次: {group.turnId.slice(0, 12)}... · 共 {group.thinkingCount} 步思考, {group.callCount} 次工具调用
            </span>
          </div>
          <button className="drawer-close" onClick={onClose} title="关闭抽屉 (Esc)">
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
                        <div className="trace-card-title">思考进程 #{idx + 1}</div>
                        <div className="trace-card-content">
                          {ev.text.trim() ? (
                            <pre className="thinking-raw-text">{ev.text}</pre>
                          ) : (
                            <div className="thinking-empty">
                              加密 reasoning,无明文 —— Claude 仅在 JSONL 里写了 <code>signature</code>,没有把推理文字暴露给客户端。
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
                          工具调用 #{idx + 1} 
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
