import type { IncomingMessage, ServerResponse } from 'node:http'
import { approvalStore } from '../approvals/approval-store'
import type { ApprovalStatus } from '../permissions/types'
import { runRegistry } from '../runs/run-registry'

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
      runRegistry.resolveApproval(approval.approvalId, approval.status)
    }
    sendJson(res, 200, { approval })
    return true
  }

  if (req.method === 'POST' && parts.length === 4 && (parts[3] === 'approve' || parts[3] === 'reject')) {
    const approval = await approvalStore.decide(approvalId, parts[3] === 'approve' ? 'approved' : 'rejected')
    if (!approval) {
      sendJson(res, 404, { error: 'approval not found' })
      return true
    }
    runRegistry.resolveApproval(approval.approvalId, approval.status === 'approved' ? 'approved' : 'rejected')
    sendJson(res, 200, { approval })
    return true
  }

  return false
}
