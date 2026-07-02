import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { COCKPIT_GROUP_THREADS_ROOT, COCKPIT_THREADS_ROOT } from '../config'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

// 群聊落 group-threads/<id>/attachments,单会话 follow-up 落 threads/<src>/<id>/attachments。
// 两者都要求路径位于对应根目录下且包含 /attachments/ 段。
function isWithinAttachments(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  if (!resolved.includes(`${path.sep}attachments${path.sep}`)) return false
  return [COCKPIT_GROUP_THREADS_ROOT, COCKPIT_THREADS_ROOT].some((r) =>
    resolved.startsWith(path.resolve(r) + path.sep),
  )
}

export async function handleAttachmentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/api/attachments/image') return false
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  const rawPath = url.searchParams.get('path')
  if (!rawPath) {
    sendJson(res, 400, { error: 'missing path' })
    return true
  }

  const filePath = path.resolve(rawPath)
  const mime = IMAGE_TYPES[path.extname(filePath).toLowerCase()]
  if (!mime || !isWithinAttachments(filePath)) {
    sendJson(res, 403, { error: 'forbidden' })
    return true
  }

  let st
  try {
    st = await fsp.stat(filePath)
  } catch {
    sendJson(res, 404, { error: 'not found' })
    return true
  }
  if (!st.isFile()) {
    sendJson(res, 404, { error: 'not found' })
    return true
  }

  res.statusCode = 200
  res.setHeader('Content-Type', mime)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  fs.createReadStream(filePath).pipe(res)
  return true
}
