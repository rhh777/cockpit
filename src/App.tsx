import { useEffect, useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { SessionList } from './pages/SessionList'
import { SessionDetail } from './pages/SessionDetail'
import { Splitter } from './components/Splitter'
import { SettingsPanel } from './components/SettingsPanel'
import { Icon } from './components/Icon'
import { useResizable } from './hooks/useResizable'
import { applyFontSizePreference, applyThemePreference } from './lib/preferences'

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { width: sidebarWidth, onDragStart } = useResizable(
    'cockpit.sidebarWidth',
    248,
    180,
    500,
    'left',
  )

  useEffect(() => {
    applyThemePreference()
    applyFontSizePreference()
  }, [])

  return (
    <div className="app">
      {/* macOS 红绿灯避让区 + 全局可拖拽 title bar。
          padding-left 78px 给红绿灯让位;品牌字样落在这里,顺便统一三列顶部基准线。 */}
      <div className="titlebar">
        <span className="titlebar-brand">✦ cockpit</span>
        <span className="titlebar-spacer" />
        <button className="titlebar-icon-btn" onClick={() => setSettingsOpen(true)} title="设置">
          <Icon name="settings" size={14} />
        </button>
      </div>
      <div className="app-body">
        <SessionList style={{ width: sidebarWidth }} />
        <Splitter side="left" onDragStart={onDragStart} />
        <Routes>
          <Route
            path="/"
            element={
              <div className="detail">
                <div className="empty">选个 session,看看 agent 干了什么</div>
              </div>
            }
          />
          <Route path="/:source/:id" element={<SessionDetail />} />
        </Routes>
      </div>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
