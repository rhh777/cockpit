// Handoff 类型,见 docs/07-native-continuation-and-handoff.md。
// 不要在这里重新声明 Source / AgentName,从 loaders/types 复用。

import type { Source } from '../loaders/types'

export type HandoffTarget = 'codex' | 'claude' | 'both'
export type TranscriptMode = 'full' | 'recent' | 'summary-only'

export type HandoffSourceKind = 'native-session' | 'cockpit-followup' | 'group-thread'

export type HandoffSourceRef =
  | { kind: 'native-session'; source: Source; sessionId: string }
  | { kind: 'cockpit-followup'; source: Source; sessionId: string }
  | { kind: 'group-thread'; groupThreadId: string }

export interface HandoffSourceSnapshot {
  sourceUpdatedAt: string | null
  sourceEventCount: number | null
  summaryRevision?: number
  fileMtimeMs?: number
}

export interface HandoffManifest {
  handoffId: string
  source: {
    kind: HandoffSourceKind
    source?: Source
    sessionId?: string
    groupThreadId?: string
  }
  createdAt: string
  cwd: string | null
  title: string
  snapshotMode: 'snapshot'
  sourceSnapshot: HandoffSourceSnapshot
  files: {
    canonical: {
      summary: string
      transcript: string
      decisions: string
      taskState: string
      fileRefs: string
    }
    entries: {
      codex: string
      claude: string
    }
  }
  nativeLinks: NativeLink[]
}

export interface HandoffFreshness {
  status: 'fresh' | 'stale' | 'unknown'
  staleSince?: string
  reason?: string
}

export interface HandoffDetail extends HandoffManifest {
  freshness: HandoffFreshness
}

export type NativeLinkLevel = 'none' | 'linked' | 'mirrored'
export type NativeProvider = 'codex' | 'claude'
export type NativeOpenMethod = 'deeplink' | 'app-server' | 'cli' | 'manual'

export interface NativeLink {
  id: string
  provider: NativeProvider
  handoffId: string
  createdAt: string
  method: NativeOpenMethod
  linkLevel: NativeLinkLevel
  nativeThreadId?: string
  runId?: string
  url?: string
  cwd?: string | null
  status: 'created' | 'opened' | 'failed'
  error?: string
}

export interface CreateHandoffInput {
  source: HandoffSourceRef
  target: HandoffTarget
  currentRequest?: string
  transcriptMode?: TranscriptMode
}

export interface BuiltContext {
  title: string
  cwd: string | null
  snapshot: HandoffSourceSnapshot
  canonical: {
    summary: string
    transcript: string
    decisions: string
    taskState: string
    fileRefs: string
  }
  entries: {
    codex: string
    claude: string
  }
}
