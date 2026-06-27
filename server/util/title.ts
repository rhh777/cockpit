// 把首条 user_text 清洗成人类友好的标题。
// 支持:
//   1) Claude 斜杠命令(任意顺序的 <command-name>/<command-message>/<command-args>)
//   2) Cockpit 跨 agent 转发的 prompt(# Original Session / # Current Request)
//   3) <local-command-stdout> / <local-command-stderr> / <local-command-caveat> 取内层文字
//   4) 普通带 markdown 标题/引用前缀的长文
function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1] : null
}

function stripMarkup(s: string): string {
  return s
    .replace(/<\/?[a-z][^>]*>/gi, ' ') // XML/HTML 标签
    .replace(/^\s*[#>*\-]+\s*/gm, '') // 行首的 markdown 修饰符
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function cleanTitle(text: string, maxLen = 60): string {
  if (!text) return ''
  const trimmed = text.trim()

  // 1) Claude 斜杠命令
  const cmdName = extractTag(trimmed, 'command-name')
  const cmdMsg = extractTag(trimmed, 'command-message')
  const cmdArgs = extractTag(trimmed, 'command-args')
  if (cmdName || cmdMsg) {
    const name = (cmdName ?? cmdMsg ?? '').trim().replace(/^\//, '')
    const args = (cmdArgs ?? '').trim()
    const argTail = args ? ` ${stripMarkup(args).slice(0, Math.max(0, maxLen - name.length - 3))}` : ''
    return `/${name}${argTail}`.slice(0, maxLen)
  }

  // 2) Cockpit 跨 agent 序列化 prompt:优先取 Current Request 段(请求本身才是这次会话的目的)
  if (/^#\s*Original Session\b/m.test(trimmed) || /^#\s*Current Request\b/m.test(trimmed)) {
    const idx = trimmed.search(/^#\s*Current Request\b/m)
    if (idx >= 0) {
      const tail = trimmed.slice(idx).replace(/^#\s*Current Request\b.*\n?/, '')
      // 第一行通常是固定的"请以 XX 的身份回应…"提示,跳过它
      const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
      const real = lines.find((l) => !/^请以\s+\S+\s+的身份/.test(l)) ?? lines[0] ?? ''
      const cleaned = stripMarkup(real)
      if (cleaned) return cleaned.slice(0, maxLen)
    }
    // 兜底:取 User Goal 段
    const ug = trimmed.match(/^##\s*User Goal\s*\n([\s\S]*?)(?:\n#|\n##|$)/m)
    if (ug) {
      const cleaned = stripMarkup(ug[1])
      if (cleaned) return cleaned.slice(0, maxLen)
    }
  }

  // 3) 本地命令包装
  for (const tag of ['local-command-stdout', 'local-command-stderr', 'local-command-caveat']) {
    const v = extractTag(trimmed, tag)
    if (v) {
      const cleaned = stripMarkup(v)
      if (cleaned) return cleaned.slice(0, maxLen)
    }
  }

  // 4) 默认:剥 markup + 截断
  return stripMarkup(trimmed).slice(0, maxLen)
}
