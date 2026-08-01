import { useEffect, useMemo, useState } from 'react'
import { AGENT_OPTIONS } from '../lib/agents'
import { PREFERENCES_CHANGED_EVENT, readEnabledAgents } from '../lib/preferences'
import type { AgentName } from '../lib/types'

export function useEnabledAgents(): AgentName[] {
  const [agents, setAgents] = useState<AgentName[]>(() => readEnabledAgents())

  useEffect(() => {
    const refresh = () => setAgents(readEnabledAgents())
    window.addEventListener(PREFERENCES_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, refresh)
  }, [])

  return agents
}

export function useEnabledAgentOptions() {
  const enabledAgents = useEnabledAgents()
  const enabledSet = useMemo(() => new Set(enabledAgents), [enabledAgents])
  const options = useMemo(() => AGENT_OPTIONS.filter((option) => enabledSet.has(option.value)), [enabledSet])
  return { enabledAgents, enabledSet, options }
}
