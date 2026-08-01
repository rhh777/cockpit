import type { IncomingMessage, ServerResponse } from 'node:http'
import { discoverAgentCliCapabilities } from '../adapters/model-discovery'

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
  sendJson(res, 200, await discoverAgentCliCapabilities(agent, url.searchParams.get('cwd')))
  return true
}
