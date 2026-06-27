import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function pickWithOsascript(kind: 'file' | 'directory'): Promise<string[]> {
  const script =
    kind === 'file'
      ? [
          'set chosenItems to choose file with multiple selections allowed',
          'set out to ""',
          'repeat with itemRef in chosenItems',
          'set out to out & POSIX path of itemRef & linefeed',
          'end repeat',
          'return out',
        ].join('\n')
      : [
          'set chosenItem to choose folder',
          'return POSIX path of chosenItem',
        ].join('\n')

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120000 })
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch (err) {
    const e = err as Error & { code?: number | string; stderr?: string }
    const message = `${String(e.message ?? err)}\n${String(e.stderr ?? '')}`
    if (e.code === 1 || message.includes('User canceled') || message.includes('-128')) return []
    throw err
  }
}

export async function handleNativeDialogRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/api/native-dialog/open') return false
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  const kind = url.searchParams.get('kind')
  if (kind !== 'file' && kind !== 'directory') {
    sendJson(res, 400, { error: 'invalid dialog kind' })
    return true
  }

  if (process.platform !== 'darwin') {
    sendJson(res, 501, { error: 'native dialog is only implemented for macOS dev server' })
    return true
  }

  const paths = await pickWithOsascript(kind)
  sendJson(res, 200, { paths })
  return true
}
