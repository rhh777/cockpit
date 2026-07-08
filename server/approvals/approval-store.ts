import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { COCKPIT_ROOT } from '../config'
import type { AgentName, Source } from '../loaders/types'
import type { ApprovalRequest, ApprovalScope, ApprovalStatus, Operation } from '../permissions/types'

const APPROVALS_ROOT = path.join(COCKPIT_ROOT, 'approvals')

function approvalFile(id: string): string {
  return path.join(APPROVALS_ROOT, `${id}.json`)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeApproval(approval: ApprovalRequest): Promise<void> {
  await fsp.mkdir(APPROVALS_ROOT, { recursive: true })
  await fsp.writeFile(approvalFile(approval.approvalId), JSON.stringify(approval, null, 2) + '\n', 'utf8')
}

export const approvalStore = {
  root: APPROVALS_ROOT,

  async create(input: {
    runId: string
    turnId: string
    source?: Source
    sessionId?: string
    groupThreadId?: string
    agent: AgentName
    operation: Operation
    reason?: string
  }): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      approvalId: `approval_${randomUUID()}`,
      runId: input.runId,
      turnId: input.turnId,
      source: input.source,
      sessionId: input.sessionId,
      groupThreadId: input.groupThreadId,
      agent: input.agent,
      operation: input.operation,
      status: 'pending',
      createdAt: new Date().toISOString(),
      reason: input.reason,
    }
    await writeApproval(approval)
    return approval
  },

  async read(id: string): Promise<ApprovalRequest | null> {
    if (!/^approval_[a-f0-9-]+$/i.test(id)) return null
    return readJson<ApprovalRequest>(approvalFile(id))
  },

  async list(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    if (!fs.existsSync(APPROVALS_ROOT)) return []
    const files = await fsp.readdir(APPROVALS_ROOT)
    const approvals: ApprovalRequest[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const approval = await readJson<ApprovalRequest>(path.join(APPROVALS_ROOT, file))
      if (!approval) continue
      if (status && approval.status !== status) continue
      approvals.push(approval)
    }
    return approvals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  async decide(
    id: string,
    status: Extract<ApprovalStatus, 'approved' | 'rejected'>,
    scope: ApprovalScope = 'once',
  ): Promise<ApprovalRequest | null> {
    const existing = await this.read(id)
    if (!existing) return null
    const pending = existing.status === 'pending'
    const next: ApprovalRequest = {
      ...existing,
      status: pending ? status : existing.status,
      decidedAt: pending ? new Date().toISOString() : existing.decidedAt,
      ...(pending && status === 'approved' ? { decisionScope: scope } : {}),
    }
    await writeApproval(next)
    return next
  },

  async expire(id: string): Promise<ApprovalRequest | null> {
    const existing = await this.read(id)
    if (!existing) return null
    const next: ApprovalRequest = {
      ...existing,
      status: existing.status === 'pending' ? 'expired' : existing.status,
      decidedAt: existing.status === 'pending' ? new Date().toISOString() : existing.decidedAt,
    }
    await writeApproval(next)
    return next
  },
}
