import { useEffect, useRef, useState } from 'react'
import type { AgentName } from '../lib/types'
import { AGENT_OPTIONS } from '../lib/agents'
import { AgentIcon } from './AgentIcon'
import { useI18n } from '../lib/i18n'
import { Icon } from './Icon'
import { useEnabledAgentOptions } from '../hooks/useEnabledAgents'

export function AgentPicker({
  value,
  onChange,
  className = '',
  options,
  variant = 'menu',
}: {
  value: AgentName
  onChange: (agent: AgentName) => void
  className?: string
  options?: typeof AGENT_OPTIONS
  variant?: 'menu' | 'grid'
}) {
  const { t } = useI18n()
  const { options: enabledOptions } = useEnabledAgentOptions()
  const visibleOptions = options ?? enabledOptions
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const selected = visibleOptions.find((a) => a.value === value) ?? visibleOptions[0]

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (agent: AgentName) => {
    onChange(agent)
    setOpen(false)
  }

  return (
    <div ref={ref} className={`agent-picker agent-picker-${variant} ${className}`.trim()}>
      <div className="agent-picker-scroll" role="radiogroup" aria-label="Agent">
        {visibleOptions.map((a) => (
          <button
            key={a.value}
            type="button"
            role="radio"
            aria-checked={value === a.value}
            className={`agent-picker-item ${value === a.value ? 'active' : ''} agent-${a.value}`}
            onClick={() => pick(a.value)}
            title={a.label}
          >
            <AgentIcon agent={a.value} size={16} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div className="agent-picker-menu">
        <button
          type="button"
          className={`agent-picker-trigger agent-${selected?.value}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={t('agent.select')}
        >
          <AgentIcon agent={selected?.value} size={16} />
          <span>{selected?.label}</span>
          <Icon name="chevron-right" size={13} className="agent-picker-caret" />
        </button>
        {open && (
          <div className="agent-picker-popover" role="listbox" aria-label="Agent">
            <div className="agent-picker-popover-head">Agent</div>
          {visibleOptions.map((a) => (
              <button
                key={a.value}
                type="button"
                role="option"
                aria-selected={value === a.value}
                className={`agent-picker-option ${value === a.value ? 'active' : ''} agent-${a.value}`}
                onClick={() => pick(a.value)}
              >
                <AgentIcon agent={a.value} size={17} />
                <span>{a.label}</span>
                {value === a.value && <Icon name="check" size={14} />}
              </button>
          ))}
          </div>
        )}
      </div>
    </div>
  )
}
