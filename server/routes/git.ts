import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const execFileAsync = promisify(execFile)

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

// GET /api/git/changed?cwd=<absolute-dir>
// 返回 { root: string, files: [{ path, status }] }
// path 会规范到绝对路径,方便与 tool_use 里的 file_path 做交叉比对。
// status: 'M'|'A'|'D'|'R'|'??' 等,原样透传 git 输出。
export async function handleGitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/api/git/changed') return false
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  const cwd = url.searchParams.get('cwd') ?? ''
  if (!cwd || !path.isAbsolute(cwd)) {
    sendJson(res, 400, { error: 'cwd must be an absolute path' })
    return true
  }
  try {
    const s = await stat(cwd)
    if (!s.isDirectory()) {
      sendJson(res, 400, { error: 'cwd is not a directory' })
      return true
    }
  } catch {
    sendJson(res, 404, { error: 'cwd does not exist' })
    return true
  }

  // 拿仓库根,方便回填绝对路径。非 git 仓库返回空列表(不当错误)。
  let root: string
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: 5000,
    })
    root = stdout.trim()
  } catch {
    sendJson(res, 200, { root: null, files: [] })
    return true
  }

  // porcelain 输出:每行 " M path" / "?? path" 等,前两列是 status。
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, 'status', '--porcelain=1', '--untracked-files=normal'],
    { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
  )
  const files: Array<{ path: string; status: string }> = []
  for (const raw of stdout.split('\n')) {
    if (!raw) continue
    const status = raw.slice(0, 2).trim() || '?'
    const rel = raw.slice(3)
    // 处理 rename:"old -> new"
    const target = rel.includes(' -> ') ? rel.split(' -> ').pop()! : rel
    files.push({ path: path.resolve(root, target), status })
  }
  sendJson(res, 200, { root, files })
  return true
}
