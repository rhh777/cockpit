import os from 'node:os'
import path from 'node:path'
import { ALLOWED_ROOTS } from '../config'

const HOME = os.homedir()

// 用户可提交给 Review Room / 群聊的工作目录:必须在 HOME 下,且不在敏感 dotdir 里。
// 目标不是"绝对安全",而是拒掉像 /etc、~/.ssh、~/.aws、~/.gnupg 这类误操作/勾引路径,
// 因为 review 流程会在这个 cwd 里 `git rev-parse HEAD` 并起 agent 子进程。
const SENSITIVE_DOT_DIRS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.gh',
  '.docker',
  '.kube',
  '.npmrc',
  '.yarnrc',
])

export function isUserWorkspacePath(p: string): boolean {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false
  const resolved = path.resolve(p)
  const home = path.resolve(HOME)
  if (resolved !== home && !resolved.startsWith(home + path.sep)) return false
  const rel = path.relative(home, resolved)
  const first = rel.split(path.sep)[0] ?? ''
  if (SENSITIVE_DOT_DIRS.has(first)) return false
  return true
}

// uuid v4/v7 等形态(Claude/Codex session id 均为 uuid;cockpit 自建 thread 也是 uuid)。
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{8,64}$/

export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id)
}

export function isValidSessionIdForSource(source: string, id: string): boolean {
  if (source === 'opencode') return OPENCODE_SESSION_RE.test(id)
  return isValidSessionId(id)
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
