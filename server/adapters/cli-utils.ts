import { spawn } from 'node:child_process'

// 检测本机 CLI 是否真的可执行(不止 PATH 里有,还要能跑起来 —— 本机 codex
// 的 vendored 平台二进制可能缺失,which 命中但 spawn ENOENT)。
export function commandExists(cmd: string, probeArgs: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const child = spawn(cmd, probeArgs, { stdio: 'ignore' })
      child.on('error', () => done(false)) // ENOENT 等
      child.on('close', (code) => done(code === 0))
      setTimeout(() => {
        child.kill()
        done(false)
      }, 8000)
    } catch {
      done(false)
    }
  })
}
