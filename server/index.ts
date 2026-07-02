import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleAttachmentsRoute } from './routes/attachments'
import { handleNativeRoute } from './routes/native'
import { handleGitRoute } from './routes/git'
import { handleNativeDialogRoute } from './routes/native-dialog'
import { handleGroupThreadsRoute } from './routes/group-threads'
import { handleHandoffsRoute } from './routes/handoffs'
import { handleRunsRoute } from './routes/runs'
import { handleSessionsRoute } from './routes/sessions'
import { handleSettingsRoute } from './routes/settings'
import { handleThreadsRoute } from './routes/threads'

type Next = (err?: unknown) => void

// Vite middleware:同进程 Node 后端,只接管 /api/*,其余交给 Vite(docs/01 §二 L3)。
export function cockpitApi() {
  return async function (req: IncomingMessage, res: ServerResponse, next: Next) {
    const rawUrl = req.url ?? '/'
    if (!rawUrl.startsWith('/api/')) return next()

    let url: URL
    try {
      url = new URL(rawUrl, 'http://localhost')
    } catch {
      return next()
    }

    try {
      if (await handleAttachmentsRoute(req, res, url)) return
      if (await handleNativeDialogRoute(req, res, url)) return
      if (await handleGitRoute(req, res, url)) return
      if (await handleRunsRoute(req, res, url)) return
      if (await handleNativeRoute(req, res, url)) return
      if (await handleHandoffsRoute(req, res, url)) return
      if (await handleGroupThreadsRoute(req, res, url)) return
      if (await handleThreadsRoute(req, res, url)) return
      if (await handleSettingsRoute(req, res, url)) return
      if (await handleSessionsRoute(req, res, url)) return
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (err) {
      console.error('[cockpit api]', err)
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'internal error', detail: String(err) }))
      } else {
        res.end()
      }
    }
  }
}
