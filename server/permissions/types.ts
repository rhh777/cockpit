import type { AgentName, Source } from '../loaders/types'

export type ApprovalMode = 'ask' | 'auto-safe' | 'full-access'

export interface RunPermissions {
  mode: ApprovalMode
  allowNetwork: boolean
  allowWorkspaceWrite: boolean
  allowOutsideWorkspaceWrite: boolean
  allowShell: boolean
}

export type Operation =
  | { kind: 'file_read'; path: string }
  | { kind: 'file_write'; path: string; action: 'create' | 'edit' | 'delete' }
  | { kind: 'shell'; command: string; cwd?: string | null }
  | { kind: 'network'; host?: string; url?: string }

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** 审批决议(docs/12 C2):approved = 仅本次;approved_always = 本 run 内同类操作不再询问。 */
export type ApprovalDecision = 'approved' | 'approved_always' | 'rejected'

/** 「总是允许」的记忆范围,持久化在 ApprovalRequest 上供审计。 */
export type ApprovalScope = 'once' | 'always'

export interface ApprovalRequest {
  approvalId: string
  runId: string
  turnId: string
  source?: Source
  sessionId?: string
  groupThreadId?: string
  agent: AgentName
  operation: Operation
  status: ApprovalStatus
  createdAt: string
  decidedAt?: string
  reason?: string
  /** status=approved 时的放行范围;缺省视为 once(兼容旧记录)。 */
  decisionScope?: ApprovalScope
}

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'ask'; approvalId: string; reason?: string }

export const DEFAULT_RUN_PERMISSIONS: RunPermissions = {
  mode: 'ask',
  allowNetwork: false,
  allowWorkspaceWrite: false,
  allowOutsideWorkspaceWrite: false,
  allowShell: false,
}

export function permissionsForMode(mode: ApprovalMode): RunPermissions {
  if (mode === 'full-access') {
    return {
      mode,
      allowNetwork: true,
      allowWorkspaceWrite: true,
      allowOutsideWorkspaceWrite: true,
      allowShell: true,
    }
  }
  if (mode === 'auto-safe') {
    return {
      mode,
      allowNetwork: true,
      allowWorkspaceWrite: true,
      allowOutsideWorkspaceWrite: false,
      allowShell: false,
    }
  }
  return { ...DEFAULT_RUN_PERMISSIONS }
}

export function normalizeRunPermissions(value: unknown): RunPermissions {
  if (!value || typeof value !== 'object') return { ...DEFAULT_RUN_PERMISSIONS }
  const raw = value as Partial<RunPermissions>
  const mode: ApprovalMode =
    raw.mode === 'auto-safe' || raw.mode === 'full-access' || raw.mode === 'ask' ? raw.mode : 'ask'
  const base = permissionsForMode(mode)
  return {
    mode,
    allowNetwork: typeof raw.allowNetwork === 'boolean' ? raw.allowNetwork : base.allowNetwork,
    allowWorkspaceWrite:
      typeof raw.allowWorkspaceWrite === 'boolean' ? raw.allowWorkspaceWrite : base.allowWorkspaceWrite,
    allowOutsideWorkspaceWrite:
      typeof raw.allowOutsideWorkspaceWrite === 'boolean'
        ? raw.allowOutsideWorkspaceWrite
        : base.allowOutsideWorkspaceWrite,
    allowShell: typeof raw.allowShell === 'boolean' ? raw.allowShell : base.allowShell,
  }
}
