import type { EventEnvelope, SessionDetail, SessionSummary } from './types'

// SessionSummary 去掉 server 内部字段 filePath。
export type SessionSummaryDTO = Omit<SessionSummary, 'filePath'>
export type SessionDetailDTO = Omit<SessionDetail, 'summary'> & {
  summary: Omit<SessionSummary, 'filePath'>
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export function fetchSessions(): Promise<SessionSummaryDTO[]> {
  return getJson('/api/sessions')
}

export interface ActiveRunDTO {
  runId: string
  kind: 'followup' | 'native-resume' | 'group-member'
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  source?: string
  sessionId?: string
  groupThreadId?: string
  turnId: string
  agent: string
  startedAt: string
}

export async function fetchRunningRuns(): Promise<ActiveRunDTO[]> {
  const json = await getJson<{ runs?: ActiveRunDTO[] }>('/api/runs?status=running')
  return Array.isArray(json.runs) ? json.runs : []
}

export function fetchSessionDetail(source: string, id: string): Promise<SessionDetailDTO> {
  return getJson(`/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}`)
}

export async function createGroupThread(body: { title?: string; cwd?: string | null } = {}): Promise<{
  id: string
}> {
  const res = await fetch('/api/group-threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as { id: string }
}

export async function renameGroupThread(id: string, title: string): Promise<void> {
  const res = await fetch(`/api/group-threads/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}

export async function deleteGroupThread(id: string): Promise<void> {
  const res = await fetch(`/api/group-threads/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}

export async function revealSession(
  source: string,
  id: string,
  target: 'native' | 'followups' = 'native',
): Promise<void> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}/reveal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    },
  )
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}

export interface ChangesResult {
  changed: boolean
  total: number
  newEvents: EventEnvelope[]
  reset?: boolean
}

// 游标式增量(docs/01 §五流程 C)。只回第 sinceEventCount 条之后的事件。
export function fetchChanges(
  source: string,
  id: string,
  sinceEventCount: number,
): Promise<ChangesResult> {
  return getJson(
    `/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(id)}/changes?sinceEventCount=${sinceEventCount}`,
  )
}

export interface SettingsDiagnostics {
  roots: {
    cockpit: string
    followups: string
    claudeProjects: string
    codexSessions: string
    codexIndex: string
  }
  agents: { name: 'claude' | 'codex'; available: boolean; error?: string }[]
}

export function fetchSettingsDiagnostics(): Promise<SettingsDiagnostics> {
  return getJson('/api/settings/diagnostics')
}
