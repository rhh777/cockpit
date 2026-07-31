import path from 'node:path'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'codex:'])

export function isAllowedExternalUrl(raw: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

export function isSameAppOrigin(raw: string, appUrl: string): boolean {
  try {
    return new URL(raw).origin === new URL(appUrl).origin
  } catch {
    return false
  }
}

export function resolveStaticAsset(distDir: string, requestUrl: string): string | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null

  const candidate = path.resolve(distDir, `.${pathname === '/' ? '/index.html' : pathname}`)
  const relative = path.relative(path.resolve(distDir), candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return candidate
}
