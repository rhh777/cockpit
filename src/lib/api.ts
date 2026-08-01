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
  parentTurnId?: string
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

export interface AgentModelOptionDTO {
  value: string
  label: string
  hint?: string
  efforts?: string[]
  defaultEffort?: string
  isDefault?: boolean
}

export interface AgentCliCapabilitiesDTO {
  models: AgentModelOptionDTO[]
  modelDetection: {
    status: 'detected' | 'cached' | 'unsupported' | 'failed'
    reason?: string
    detail?: string
    cachedAt?: string
  }
  effortDetection: {
    status: 'detected' | 'unsupported' | 'failed' | 'embedded'
    values: string[]
    reason?: string
    detail?: string
  }
}

const agentCapabilitiesCache = new Map<string, Promise<AgentCliCapabilitiesDTO>>()

export function fetchAgentCapabilities(
  agent: string,
  cwd?: string | null,
  refresh = false,
): Promise<AgentCliCapabilitiesDTO> {
  const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
  const key = `${agent}\0${cwd ?? ''}`
  if (refresh) agentCapabilitiesCache.delete(key)
  const existing = agentCapabilitiesCache.get(key)
  if (existing) return existing
  const request = getJson<AgentCliCapabilitiesDTO>(`/api/agents/${encodeURIComponent(agent)}/models${qs}`)
  agentCapabilitiesCache.set(key, request)
  request.catch(() => agentCapabilitiesCache.delete(key))
  return request
}

export async function fetchAgentModels(agent: string, cwd?: string | null): Promise<AgentModelOptionDTO[]> {
  const json = await fetchAgentCapabilities(agent, cwd)
  return Array.isArray(json.models) ? json.models : []
}

export async function createGroupThread(body: { title?: string; cwd?: string | null; agents?: string[] } = {}): Promise<{
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

export interface CreateReviewRoomBody {
  source:
    | { kind: 'native-session' | 'cockpit-followup'; source: string; sessionId: string; title?: string }
    | { kind: 'group-thread'; groupThreadId: string; title?: string }
    | { kind: 'repository' | 'directory' | 'document'; path: string; title?: string }
    | { kind: 'files'; paths: string[]; title?: string }
    | { kind: 'freeform'; freeformText?: string; title?: string }
  goal?: string
  preset?: string
  participants?: string[]
  mode?: 'parallel' | 'serial'
  startReview?: boolean
  promptLocale?: 'en' | 'zh-CN'
}

export type ReviewIssueSeverity = 'blocker' | 'major' | 'minor' | 'nit'
export type ReviewIssueOutcome = 'verified' | 'still-broken' | 'needs-discussion'
export type ReviewIssueStatus = 'open' | 'fixed' | 'wontfix' | 'needs-check'
/** 状态来源:manual = 用户手改,derived = 由 fix/verify 的 outcome 推出,default = 兜底 open。 */
export type ReviewIssueStatusSource = 'manual' | 'derived' | 'default'
export interface ReviewIssueDTO {
  id: string
  agent: string
  title: string
  severity: ReviewIssueSeverity
  path?: string
  line?: number
  body: string
  refIssueIds?: string[]
  outcome?: ReviewIssueOutcome
  /** 服务端解析后的状态(优先级规则只在服务端实现一次,前端不重复推导)。 */
  status?: ReviewIssueStatus
  statusSource?: ReviewIssueStatusSource
}
export interface ReviewIssueSetDTO {
  id: string
  reviewRoomId: string
  roundId: string
  createdAt: string
  issues: ReviewIssueDTO[]
  agreements: string[]
  disagreements: string[]
  recommendedNextStep?: string
}
export interface ReviewRoomState {
  reviewRoomId: string
  groupThreadId: string
  goal: string
  preset: string | null
  promptLocale?: 'en' | 'zh-CN'
  phase: 'draft' | 'review' | 'compare' | 'fix' | 'verify' | 'done'
  participants: string[]
  rounds: {
    id: string
    kind: 'review' | 'fix' | 'verify' | 'fresh-review'
    mode: 'parallel' | 'serial' | 'single' | 'manual'
    agents: string[]
    startedAt: string
    completedAt?: string
    status: 'running' | 'completed' | 'failed' | 'aborted' | 'awaiting-user'
    groupTurnId?: string
  }[]
  issueSets: ReviewIssueSetDTO[]
  /** source snapshot 与当前状态的比对结果;只提示,不自动刷新快照。 */
  sourceFreshness?: {
    status: 'fresh' | 'stale' | 'unknown' | 'missing'
    reason?: string
    detail?: string
  }
  /** fresh review 回链结果:从各 child 房间派生的只读视图。 */
  freshReviewRollup?: {
    results: {
      childReviewRoomId: string
      completed: boolean
      verified: boolean
      childPhase?: string
      newIssues: ReviewIssueDTO[]
    }[]
    hasNewIssues: boolean
    verified: boolean
    newIssueCount: number
  }
  conclusion?: string
  doneAt?: string
  statusSummary?: {
    total: number
    open: number
    fixed: number
    wontfix: number
    needsCheck: number
    allResolved: boolean
  }
  freshReviews?: {
    parentReviewRoomId: string
    childReviewRoomId: string
    reviewerAgents: string[]
    createdAt: string
    reason: string
  }[]
  source: {
    kind: string
    title: string
    cwd: string | null
    snapshotCreatedAt: string
    nativeSession?: { source: string; sessionId: string }
    groupThreadId?: string
    paths?: { kind: string; path: string; name: string }[]
    freeformText?: string
  }
  createdAt: string
  updatedAt: string
}

export interface FreshReviewResponse {
  parentReviewRoomId: string
  childReviewRoomId: string
  groupThreadId: string
  startError?: string
}

export async function startFreshReview(
  id: string,
  body: {
    reviewerAgents?: string[]
    reason?: 'verify' | 'new-risks' | 'user-requested'
    mode?: 'parallel' | 'serial'
    goal?: string
  } = {},
): Promise<FreshReviewResponse> {
  const res = await fetch(`/api/review-rooms/${encodeURIComponent(id)}/fresh-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }
  return (await res.json()) as FreshReviewResponse
}

export async function extractReviewIssues(id: string, opts?: { roundId?: string; force?: boolean }): Promise<ReviewRoomState | null> {
  const res = await fetch(`/api/review-rooms/${encodeURIComponent(id)}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const json = await res.json()
  return (json.review ?? null) as ReviewRoomState | null
}

export async function setReviewIssueStatus(
  id: string,
  body: { roundId: string; issueId: string; status: ReviewIssueStatus | null; note?: string },
): Promise<ReviewRoomState | null> {
  const res = await fetch(`/api/review-rooms/${encodeURIComponent(id)}/issue-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status}`)
  const json = (await res.json()) as { review?: ReviewRoomState }
  return (json.review ?? null) as ReviewRoomState | null
}

export async function setManualFix(id: string, active: boolean): Promise<ReviewRoomState | null> {
  const res = await fetch(`/api/review-rooms/${encodeURIComponent(id)}/manual-fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  })
  if (!res.ok) throw new Error(`${res.status}`)
  const json = (await res.json()) as { review?: ReviewRoomState }
  return (json.review ?? null) as ReviewRoomState | null
}

export async function finishReviewRoom(
  id: string,
  body: { done: boolean; conclusion?: string },
): Promise<ReviewRoomState | null> {
  const res = await fetch(`/api/review-rooms/${encodeURIComponent(id)}/done`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  const json = (await res.json()) as { review?: ReviewRoomState }
  return (json.review ?? null) as ReviewRoomState | null
}

export interface ReviewRoomDTO {
  reviewRoomId: string
  groupThreadId: string
  state: { id: string }
  review?: ReviewRoomState
  started?: unknown
  startError?: string
}

export function createReviewRoom(body: CreateReviewRoomBody): Promise<ReviewRoomDTO> {
  return postJson('/api/review-rooms', body)
}

export async function cancelReviewRoom(id: string): Promise<ReviewRoomState | null> {
  const res = await fetch(`/api/review-rooms/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const json = await res.json() as { review?: ReviewRoomState | null }
  return json.review ?? null
}

export async function fetchReviewRoom(id: string): Promise<ReviewRoomState | null> {
  const res = await fetch(`/api/review-rooms/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const json = await res.json() as { review?: ReviewRoomState | null; warning?: { code?: string; message?: string } }
  if (json.warning) throw new Error(json.warning.message ?? json.warning.code ?? 'corrupt review state')
  return (json.review ?? null) as ReviewRoomState | null
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
    settings: string
    followups: string
    claudeProjects: string
    codexSessions: string
    codexIndex: string
    opencodeData: string
    opencodeDb: string
    cursorData: string
    cursorProjects: string
    cursorChats: string
  }
  agents: { name: string; available: boolean; error?: string }[]
}

export function fetchSettingsDiagnostics(): Promise<SettingsDiagnostics> {
  return getJson('/api/settings/diagnostics')
}

export async function warmupAgent(agent: string): Promise<void> {
  await fetch('/api/settings/warmup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
  }).catch(() => {})
}
