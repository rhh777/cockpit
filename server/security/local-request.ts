import type { IncomingMessage } from 'node:http'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface LocalRequestCheck {
  ok: boolean
  status?: 403
  reason?: 'non-loopback-host' | 'cross-site-request' | 'origin-mismatch'
}

function parseHost(value: string | undefined): URL | null {
  if (!value) return null
  try {
    return new URL(`http://${value}`)
  } catch {
    return null
  }
}

/**
 * Cockpit exposes powerful local-only endpoints. Browser same-origin policy prevents
 * reading responses, but without this guard another site could still submit a POST.
 * Requests made by local CLI tools normally omit Origin/Sec-Fetch-Site and remain valid.
 */
export function checkLocalApiRequest(input: {
  method?: string
  host?: string
  origin?: string
  fetchSite?: string
}): LocalRequestCheck {
  const target = parseHost(input.host)
  if (!target || !LOOPBACK_HOSTS.has(target.hostname)) {
    return { ok: false, status: 403, reason: 'non-loopback-host' }
  }

  if (input.fetchSite === 'cross-site') {
    return { ok: false, status: 403, reason: 'cross-site-request' }
  }

  const method = (input.method ?? 'GET').toUpperCase()
  if (!SAFE_METHODS.has(method) && input.origin) {
    try {
      const origin = new URL(input.origin)
      if (origin.protocol !== 'http:' || origin.host !== target.host || !LOOPBACK_HOSTS.has(origin.hostname)) {
        return { ok: false, status: 403, reason: 'origin-mismatch' }
      }
    } catch {
      return { ok: false, status: 403, reason: 'origin-mismatch' }
    }
  }

  return { ok: true }
}

export function checkIncomingLocalApiRequest(req: IncomingMessage): LocalRequestCheck {
  return checkLocalApiRequest({
    method: req.method,
    host: req.headers.host,
    origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    fetchSite: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined,
  })
}
