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
  kind: 'followup' | 'native-resume' | 'group-member' | 'native-continuation'
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

export type HandoffTarget = 'codex' | 'claude' | 'both'
export type NativeProvider = 'codex' | 'claude'
export type NativeOpenMethod = 'deeplink' | 'app-server' | 'cli' | 'manual'
export type NativeLinkLevel = 'none' | 'linked' | 'mirrored'

export interface HandoffSourceRefDTO {
  kind: 'native-session' | 'cockpit-followup' | 'group-thread'
  source?: string
  sessionId?: string
  groupThreadId?: string
}

export interface NativeLinkDTO {
  id: string
  provider: NativeProvider
  handoffId: string
  createdAt: string
  method: NativeOpenMethod
  linkLevel: NativeLinkLevel
  nativeThreadId?: string
  url?: string
  cwd?: string | null
  status: 'created' | 'opened' | 'failed'
  error?: string
}

export interface HandoffStatsDTO {
  transcriptMode: 'full' | 'recent' | 'summary-only'
  transcriptTruncated: boolean
  eventsIncluded: number
  eventsTotal: number
  approxTokens: number
}

export interface HandoffManifestDTO {
  handoffId: string
  source: HandoffSourceRefDTO
  createdAt: string
  cwd: string | null
  title: string
  snapshotMode: 'snapshot'
  predecessorId?: string
  inheritedTarget?: HandoffTarget
  sourceSnapshot: {
    sourceUpdatedAt: string | null
    sourceEventCount: number | null
    summaryRevision?: number
    fileMtimeMs?: number
  }
  stats?: HandoffStatsDTO
  files: {
    canonical: {
      summary: string
      transcript: string
      decisions: string
      taskState: string
      fileRefs: string
    }
    entries: { codex: string; claude: string }
  }
  nativeLinks: NativeLinkDTO[]
}

export interface HandoffDetailDTO extends HandoffManifestDTO {
  freshness: { status: 'fresh' | 'stale' | 'unknown'; staleSince?: string; reason?: string }
}

export interface OpenNativeResponse {
  nativeLink: NativeLinkDTO
  fallbackPrompt?: string
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }
  return (await res.json()) as T
}

export function createHandoff(body: {
  source: HandoffSourceRefDTO
  target?: HandoffTarget
  currentRequest?: string
  transcriptMode?: 'full' | 'recent' | 'summary-only'
}): Promise<HandoffManifestDTO> {
  return postJson('/api/handoffs', body)
}

export function fetchHandoff(id: string): Promise<HandoffDetailDTO> {
  return getJson(`/api/handoffs/${encodeURIComponent(id)}`)
}

export function openNativeHandoff(
  handoffId: string,
  body: { provider: NativeProvider; method?: NativeOpenMethod | 'auto' },
): Promise<OpenNativeResponse> {
  return postJson(`/api/handoffs/${encodeURIComponent(handoffId)}/open-native`, body)
}

export function refreshHandoff(id: string): Promise<HandoffManifestDTO> {
  return postJson(`/api/handoffs/${encodeURIComponent(id)}/refresh`, {})
}

export interface MirrorResultDTO {
  ok: boolean
  linkLevel: NativeLinkLevel
  mirrorFile?: string
  error?: string
  itemCount?: number
}

export async function mirrorNativeLink(handoffId: string, linkId: string): Promise<MirrorResultDTO> {
  const res = await fetch(
    `/api/handoffs/${encodeURIComponent(handoffId)}/native-links/${encodeURIComponent(linkId)}/mirror`,
    { method: 'POST' },
  )
  return (await res.json()) as MirrorResultDTO
}

export interface HandoffCapabilitiesDTO {
  codex: ProviderCapabilitiesDTO
  claude: ProviderCapabilitiesDTO
}
export interface ProviderCapabilitiesDTO {
  provider: 'codex' | 'claude'
  cliAvailable: boolean
  supportsDeeplink: boolean
  supportsAppServer: boolean
  supportsCli: boolean
  supportsManual: boolean
}

export function fetchHandoffCapabilities(): Promise<HandoffCapabilitiesDTO> {
  return getJson('/api/handoffs/capabilities')
}

export async function revealHandoff(id: string): Promise<void> {
  const res = await fetch(`/api/handoffs/${encodeURIComponent(id)}/reveal`, { method: 'POST' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
}

export function groupFromSession(body: {
  source: string
  sessionId: string
  agents?: string[]
  title?: string
  includeRecentEvents?: number | 'all'
}): Promise<{ groupThreadId: string }> {
  return postJson('/api/group-threads/from-session', body)
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
