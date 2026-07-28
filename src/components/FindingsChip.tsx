import { useState } from 'react'
import { Icon } from './Icon'
import type { FindingsSplit } from '../lib/findings'

export function FindingsChip({ block }: { block: FindingsSplit }) {
  const [open, setOpen] = useState(false)
  if (!block.rawBlock) return null
  const s = block.summary
  const label = s
    ? [
        s.issues > 0 ? `${s.issues} issue${s.issues === 1 ? '' : 's'}` : '',
        s.results > 0 ? `${s.results} result${s.results === 1 ? '' : 's'}` : '',
        s.next ? `next: ${s.next}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'findings block'
  return (
    <div className={`findings-chip ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="findings-chip-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="findings-chip-kicker">FINDINGS</span>
        <span className="findings-chip-summary">{label || 'findings block'}</span>
        <span className={`findings-chip-caret ${open ? 'open' : ''}`}>
          <Icon name="chevron-right" size={11} />
        </span>
      </button>
      {open && (
        <pre className="findings-chip-body">
          <code>{block.json ?? block.rawBlock}</code>
        </pre>
      )}
    </div>
  )
}
