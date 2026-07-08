import type { IncomingMessage, ServerResponse } from 'node:http'
import { approvalStore } from '../approvals/approval-store'
import type { ApprovalRequest, ApprovalScope, ApprovalStatus } from '../permissions/types'
import { runRegistry } from '../runs/run-registry'

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function decisionOf(approval: ApprovalRequest): 'approved' | 'approved_always' | 'rejected' {
  if (approval.status !== 'approved') return 'rejected'
  return approval.decisionScope === 'always' ? 'approved_always' : 'approved'
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function parseStatus(value: string | null): ApprovalStatus | undefined {
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'expired') return value
  return undefined
}

export async function handleApprovalsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[1] !== 'approvals') return false

  if (req.method === 'GET' && parts.length === 2) {
    const approvals = await approvalStore.list(parseStatus(url.searchParams.get('status')))
    sendJson(res, 200, { approvals })
    return true
  }

  const approvalId = parts[2] ? decodeURIComponent(parts[2]) : ''

  if (req.method === 'GET' && parts.length === 3) {
    const approval = await approvalStore.read(approvalId)
    if (!approval) {
      sendJson(res, 404, { error: 'approval not found' })
      return true
    }
    if (approval.status === 'approved' || approval.status === 'rejected') {
      runRegistry.resolveApproval(approval.approvalId, decisionOf(approval))
    }
    sendJson(res, 200, { approval })
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && (parts[3] === 'approve' || parts[3] === 'reject')) {
    // body.scope: 'once'(默认)| 'always' —— 「总是允许」= 本 run 内同类操作不再询问(docs/12 C2)。
    const body = await readBody(req)
    const scope: ApprovalScope = body.scope === 'always' ? 'always' : 'once'
    const approval = await approvalStore.decide(approvalId, parts[3] === 'approve' ? 'approved' : 'rejected', scope)
    if (!approval) {
      sendJson(res, 404, { error: 'approval not found' })
      return true
    }
    runRegistry.resolveApproval(approval.approvalId, decisionOf(approval))
    sendJson(res, 200, { approval })
    return true
  }

  return false
}
