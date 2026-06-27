import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function statQuiet(filePath: string) {
  try {
    return await fs.stat(filePath)
  } catch {
    return null
  }
}

async function nearestExistingPath(filePath: string): Promise<{ path: string; isDirectory: boolean }> {
  let cur = path.resolve(filePath)
  while (true) {
    const st = await statQuiet(cur)
    if (st) return { path: cur, isDirectory: st.isDirectory() }
    const parent = path.dirname(cur)
    if (parent === cur) return { path: cur, isDirectory: true }
    cur = parent
  }
}

export async function revealInFileManager(filePath: string): Promise<void> {
  const target = await nearestExistingPath(filePath)
  if (process.platform === 'darwin') {
    await run('open', ['-R', target.path])
  } else if (process.platform === 'win32') {
    await run(
      'explorer.exe',
      target.isDirectory ? [target.path] : [`/select,${target.path}`],
    )
  } else {
    await run('xdg-open', [target.isDirectory ? target.path : path.dirname(target.path)])
  }
}
