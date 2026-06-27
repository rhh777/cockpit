import path from 'node:path'
import { ALLOWED_ROOTS } from '../config'

// uuid v4/v7 等形态(Claude/Codex session id 均为 uuid;cockpit 自建 thread 也是 uuid)。
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id)
}

const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/

export function isValidSource(source: string): boolean {
  return SOURCE_RE.test(source)
}

// 不变量 13:resolve 出的 filePath 必须落在白名单根目录内,否则一律视为越权。
export function isPathWithinAllowedRoots(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  return ALLOWED_ROOTS.some((root) => {
    const r = path.resolve(root)
    return resolved === r || resolved.startsWith(r + path.sep)
  })
}
