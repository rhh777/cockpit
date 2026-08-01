import type { Source } from './types'
import { translate, type MessageKey, type ResolvedLocale } from './i18n'

export function sourceBadge(source: Source): string {
  if (source === 'claude-code') return 'Claude'
  if (source === 'codex') return 'Codex'
  if (source === 'opencode') return 'OpenCode'
  if (source === 'cursor') return 'Cursor'
  if (source === 'cockpit') return 'Group'
  return source
}

export function sourceLabel(source: Source): string {
  if (source === 'claude-code') return 'Claude Code'
  if (source === 'codex') return 'Codex'
  if (source === 'opencode') return 'OpenCode'
  if (source === 'cursor') return 'Cursor'
  if (source === 'cockpit') return 'Cockpit Group Chat'
  return source
}

// 相对时间(借 Codex 桌面端:2周/3周)。
export function relativeTime(iso: string, locale?: ResolvedLocale): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return translate('time.justNow', undefined, locale)
  if (min < 60) return translate('time.minutesAgo', { count: min }, locale)
  const hr = Math.floor(min / 60)
  if (hr < 24) return translate('time.hoursAgo', { count: hr }, locale)
  const day = Math.floor(hr / 24)
  if (day < 7) return translate('time.daysAgo', { count: day }, locale)
  const wk = Math.floor(day / 7)
  if (wk < 5) return translate('time.weeksAgo', { count: wk }, locale)
  const mo = Math.floor(day / 30)
  if (mo < 12) return translate('time.monthsAgo', { count: mo }, locale)
  return translate('time.yearsAgo', { count: Math.floor(day / 365) }, locale)
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

export function displayTitle(raw: string, maxLen = 60, locale?: ResolvedLocale): string {
  if (!raw) return translate('title.untitled', undefined, locale)
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
      // 这行中文是 serialize.ts 写进 agent prompt 的固定前缀(不是 UI 文案),跳过它取真实请求。
      // 不要跟着界面语言翻译:一改就和 server 侧 prompt 以及已落盘的历史对不上。
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
  return stripMarkup(text).slice(0, maxLen) || translate('title.untitled', undefined, locale)
}

/**
 * 兼容旧版本已经落盘的系统默认评审标题；用户自定义标题保持原样。
 *
 * 匹配的是**落盘的英文字面量**(创建时写死的默认标题),这些正则不能跟着界面语言翻译；
 * 输出侧一律走 `translate()`,不在这里拼任何用户可见文案(CLAUDE.md i18n 规则)。
 */
const LEGACY_KIND_KEYS: Record<string, MessageKey> = {
  repository: 'title.legacyKindRepository',
  folder: 'title.legacyKindFolder',
  document: 'title.legacyKindDocument',
  files: 'title.legacyKindFiles',
}

export function localizeReviewRoomTitle(raw: string, locale?: ResolvedLocale): string {
  const fresh = raw.match(/^Fresh review\s*·\s*(.+)$/i)
  if (fresh) {
    return translate('title.legacyFreshReviewOf', { title: localizeReviewRoomTitle(fresh[1], locale) }, locale)
  }
  const review = raw.match(/^(Repository|Folder|Document|Files) Review:\s*(.+)$/i)
  if (review) {
    const kind = translate(LEGACY_KIND_KEYS[review[1].toLowerCase()] ?? 'title.legacyKindFiles', undefined, locale)
    return translate('title.legacyKindReview', { kind, name: review[2] }, locale)
  }
  const generic = raw.match(/^Review:\s*(.+)$/i)
  if (generic) return translate('title.legacyReview', { name: generic[1] }, locale)
  if (/^Fresh Review$/i.test(raw)) return translate('title.legacyFreshReview', undefined, locale)
  if (/^Review Room$/i.test(raw)) return translate('title.legacyReviewRoom', undefined, locale)
  return raw
}

export function agentAvatarClass(agent?: string): { cls: string; letter: string } {
  if (agent === 'claude') return { cls: 'claude', letter: 'C' }
  if (agent === 'codex') return { cls: 'codex', letter: 'X' }
  if (agent === 'opencode') return { cls: 'opencode', letter: 'O' }
  if (agent === 'cursor') return { cls: 'cursor', letter: 'Cu' }
  return { cls: 'claude', letter: 'A' }
}
