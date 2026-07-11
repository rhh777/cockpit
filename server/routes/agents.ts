import type { IncomingMessage, ServerResponse } from 'node:http'
import { listOpenCodeModels } from '../adapters/opencode-call'

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export async function handleAgentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (req.method !== 'GET' || parts.length !== 4 || parts[1] !== 'agents' || parts[3] !== 'models') return false

  const agent = decodeURIComponent(parts[2])
  if (agent !== 'opencode') {
    sendJson(res, 200, { models: [] })
    return true
  }

  try {
    const models = await listOpenCodeModels(url.searchParams.get('cwd'))
    sendJson(res, 200, { models })
  } catch (err) {
    sendJson(res, 503, { error: String((err as Error)?.message ?? err), models: [] })
  }
  return true
}
