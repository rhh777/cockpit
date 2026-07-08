import type { IncomingMessage, ServerResponse } from 'node:http'
import { threadStore } from '../store/thread-store'
import { resolveSafe } from './resolve'

// Follow-up 的发送/执行统一走 run-registry(POST /api/sessions/:src/:id/runs,见 routes/runs.ts)。
// 本路由只保留 follow-up 数据的删除操作。

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export async function handleThreadsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean) // ['api','threads',...]
  if (parts[1] !== 'threads') return false

  const source = parts[2] ? decodeURIComponent(parts[2]) : ''
  const id = parts[3] ? decodeURIComponent(parts[3]) : ''

  // DELETE /api/threads/:src/:id  — 清空 follow-up
  if (req.method === 'DELETE' && parts.length === 4) {
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    await threadStore.clearFollowups(source, id)
    sendJson(res, 200, { ok: true })
    return true
  }

  // DELETE /api/threads/:src/:id/turns/:turnId — 删除某一轮(支持失败轮重试)
  if (req.method === 'DELETE' && parts.length === 6 && parts[4] === 'turns') {
    const filePath = await resolveSafe(source, id)
    if (!filePath) {
      sendJson(res, 404, { error: 'session not found' })
      return true
    }
    const turnId = decodeURIComponent(parts[5])
    await threadStore.deleteTurn(source, id, turnId)
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
