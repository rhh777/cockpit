import { useState } from 'react'
import type { LoaderWarning } from '../lib/types'
import { useI18n } from '../lib/i18n'

export function WarningsBanner({ warnings }: { warnings?: LoaderWarning[] }) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()
  if (!warnings || warnings.length === 0) return null
  return (
    <div className="banner warn" onClick={() => setOpen((v) => !v)}>
      ⚠ {t('warnings.summary', { count: warnings.length })} {open ? '▾' : '›'}
      {open && (
        <pre>
          {warnings
            .map((w) => `${w.line != null ? t('warnings.atLine', { line: w.line }) : ''}[${w.code}] ${w.message}`)
            .join('\n')}
        </pre>
      )}
    </div>
  )
}
