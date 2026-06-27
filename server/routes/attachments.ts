import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { COCKPIT_GROUP_THREADS_ROOT } from '../config'

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

function isWithinGroupAttachments(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const root = path.resolve(COCKPIT_GROUP_THREADS_ROOT)
  return resolved.startsWith(root + path.sep) && resolved.includes(`${path.sep}attachments${path.sep}`)
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
  if (!mime || !isWithinGroupAttachments(filePath)) {
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
