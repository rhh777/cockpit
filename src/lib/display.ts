import type { Source } from './types'

export function sourceBadge(source: Source): string {
  if (source === 'claude-code') return 'Claude'
  if (source === 'codex') return 'Codex'
  if (source === 'cockpit') return 'Group'
  return source
}

export function sourceLabel(source: Source): string {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  if (source === 'cockpit') return 'Cockpit Group Chat'
  return source
}

// 相对时间(借 Codex 桌面端:2周/3周)。
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}天前`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}周前`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}个月前`
  return `${Math.floor(day / 365)}年前`
}

// 显示用标题清洗:把首条 user_text 的几类噪音(slash 命令 / cockpit 转发 prompt /
// local-command 包装 / markdown 段头)收敛成人类可读字符串。后端 server/util/title.ts 已经做过一次,
// 这里是兜底,防止 Vite middleware 没重启拿到旧标题时 UI 难看。
function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1] : null
}

function stripMarkup(s: string): string {
  return s
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/^\s*[#>*\-]+\s*/gm, '')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function displayTitle(raw: string, maxLen = 60): string {
  if (!raw) return '(无标题)'
  const text = raw.trim()

  // 1) Claude slash 命令:<command-name> / <command-message> / <command-args> 任意顺序
  const cmdName = extractTag(text, 'command-name')
  const cmdMsg = extractTag(text, 'command-message')
  const cmdArgs = extractTag(text, 'command-args')
  if (cmdName || cmdMsg) {
    const name = (cmdName ?? cmdMsg ?? '').trim().replace(/^\//, '')
    const args = (cmdArgs ?? '').trim()
    const argTail = args ? ` ${stripMarkup(args).slice(0, Math.max(0, maxLen - name.length - 3))}` : ''
    return `/${name}${argTail}`.slice(0, maxLen)
  }
  // 2) Cockpit 跨 agent 转发 prompt
  if (/^#\s*Original Session\b/m.test(text) || /^#\s*Current Request\b/m.test(text)) {
    const idx = text.search(/^#\s*Current Request\b/m)
    if (idx >= 0) {
      const tail = text.slice(idx).replace(/^#\s*Current Request\b.*\n?/, '')
      const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
      const real = lines.find((l) => !/^请以\s+\S+\s+的身份/.test(l)) ?? lines[0] ?? ''
      const cleaned = stripMarkup(real)
      if (cleaned) return cleaned.slice(0, maxLen)
    }
    const ug = text.match(/^##\s*User Goal\s*\n([\s\S]*?)(?:\n#|\n##|$)/m)
    if (ug) {
      const cleaned = stripMarkup(ug[1])
      if (cleaned) return cleaned.slice(0, maxLen)
    }
  }
  // 3) <local-command-stdout> / <local-command-caveat>:用内层文字
  for (const tag of ['local-command-stdout', 'local-command-stderr', 'local-command-caveat']) {
    const v = extractTag(text, tag)
    if (v) return stripMarkup(v).slice(0, maxLen)
  }
  return stripMarkup(text).slice(0, maxLen) || '(无标题)'
}

export function agentAvatarClass(agent?: string): { cls: string; letter: string } {
  if (agent === 'claude') return { cls: 'claude', letter: 'C' }
  if (agent === 'codex') return { cls: 'codex', letter: 'X' }
  return { cls: 'claude', letter: 'A' }
}
