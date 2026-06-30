// GUI 启动(Finder/Dock 双击 .app)的进程 PATH 只有系统默认极简值
// (/usr/bin:/bin:/usr/sbin:/sbin),不含 homebrew / nvm / volta / ~/.local/bin 等
// 用户级 bin 目录,导致 spawn('claude'/'codex') 抛 ENOENT → 设置页"未检测到"。
//
// 这里在打包态启动时把用户登录 shell 的真实 PATH 合并进 process.env.PATH。
// dev 模式从终端启动,已继承正确 PATH,跳过(也省一次 shell 调用)。
// 零依赖:不引入 fix-path / shell-path,与项目"不装多余 npm 包"的风格一致。

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SHELL_PATH_TIMEOUT_MS = 2500

// shell 拿不到时的兜底:覆盖常见 CLI 安装目录(相对 $HOME 的展开在下方处理)。
const FALLBACK_DIRS = [
  '~/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.bun/bin',
  '~/.volta/bin',
  '~/.cargo/bin',
  '~/.nvm/versions/node', // 占位,实际多版本目录在运行时未必命中,主要靠 shell PATH
]

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 跑 zsh login 交互模式拿真实 PATH。失败返回 null,不抛。 */
function readShellPath(): string | null {
  // 优先用户当前 SHELL(通常是 zsh),退到 zsh,再退到 bash。
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const res = spawnSync(shell, ['-ilc', 'echo $PATH'], {
      timeout: SHELL_PATH_TIMEOUT_MS,
      encoding: 'utf8',
      // -i 交互模式可能挂等待输入,靠 timeout 兜底;stdio 忽略避免污染。
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (res.error || res.status !== 0) return null
    const out = (res.stdout || '').trim()
    return out || null
  } catch {
    return null
  }
}

/** 把额外路径合并进 process.env.PATH,前置(优先命中),去重。 */
function mergePaths(extra: string[]): void {
  const existing = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  const seen = new Set(existing)
  const prepended: string[] = []
  for (const dir of extra) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    prepended.push(dir)
  }
  if (prepended.length === 0) return
  process.env.PATH = [...prepended, ...existing].join(path.delimiter)
}

/**
 * 修复 GUI 启动下的 PATH。打包态在 app ready 前调用一次即可,子进程(spawn claude/codex)
 * 会继承修好的 process.env。失败静默降级,绝不阻断启动。
 */
export function fixPath(): void {
  // 1) 登录 shell 的真实 PATH(最准,能覆盖 nvm/volta/asdf 等动态路径)。
  const shellPath = readShellPath()
  if (shellPath) {
    mergePaths(shellPath.split(path.delimiter))
  }

  // 2) 兜底:shell 拿不到或缺失时,补常见安装目录(只加真实存在的)。
  mergePaths(FALLBACK_DIRS.map(expandHome).filter(dirExists))
}
