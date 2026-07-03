import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CLAUDE_PROJECTS_ROOT,
  CODEX_SESSION_INDEX,
  CODEX_SESSIONS_ROOT,
  COCKPIT_ROOT,
  COCKPIT_THREADS_ROOT,
} from '../config'
import { listAgents, resolveAgent } from '../adapters/registry'
import type { AgentName } from '../loaders/types'

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function agentStatus(name: AgentName) {
  try {
    return { name, available: await resolveAgent(name).isAvailable() }
  } catch (err) {
    return { name, available: false, error: String((err as Error)?.message ?? err) }
  }
}

export async function handleSettingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/api/settings/diagnostics') return false
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  sendJson(res, 200, {
    roots: {
      cockpit: COCKPIT_ROOT,
      followups: COCKPIT_THREADS_ROOT,
      claudeProjects: CLAUDE_PROJECTS_ROOT,
      codexSessions: CODEX_SESSIONS_ROOT,
      codexIndex: CODEX_SESSION_INDEX,
    },
    agents: await Promise.all(listAgents().map((a) => agentStatus(a.name))),
  })
  return true
}
