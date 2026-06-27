import { useState } from 'react'
import type { LoaderWarning } from '../lib/types'

export function WarningsBanner({ warnings }: { warnings?: LoaderWarning[] }) {
  const [open, setOpen] = useState(false)
  if (!warnings || warnings.length === 0) return null
  return (
    <div className="banner warn" onClick={() => setOpen((v) => !v)}>
      ⚠ 部分事件未能解析 ({warnings.length}) {open ? '▾' : '›'}
      {open && (
        <pre>
          {warnings
            .map((w) => `${w.line != null ? `行 ${w.line} ` : ''}[${w.code}] ${w.message}`)
            .join('\n')}
        </pre>
      )}
    </div>
  )
}
