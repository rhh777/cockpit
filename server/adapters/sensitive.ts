// 敏感路径/密钥过滤(docs/01 §十)。两端都跑:序列化输入 + tool_result 落盘/回显前。
// read-only ≠ 不泄密:agent 仍可主动 Read .env / id_rsa 并写进回复,回复会持久化。

// 路径黑名单:命中则该 tool_result 整体屏蔽。
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\/\\.])\.env(\.[\w-]+)?$/i,
  /(^|[\/\\.])\.env(\.[\w-]+)?[\/\\]/i,
  /\.pem$/i,
  /\bid_rsa\b/,
  /[\/\\]\.ssh[\/\\]/,
  /[\/\\]\.aws[\/\\]/,
  /[\/\\]\.kube[\/\\]/,
  /[\/\\]\.git[\/\\]/,
  /[\/\\]node_modules[\/\\]/,
  /[\/\\](dist|build)[\/\\]/,
]

// 内容级密钥标记:逐行扫描,命中行替换为占位(避免误伤正常输出)。
const SECRET_MARKERS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\baws_secret_access_key\b/i,
  /\b(api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*\S{8,}/i,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
]

export function isSensitivePath(p: unknown): boolean {
  if (typeof p !== 'string') return false
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(p))
}

// 从 tool_use input 里抽取它操作的路径(用于判断是否该屏蔽其结果)。
// shell 命令是整串,额外按空白/引号切成 token,让中段的 /x/.env 也能命中。
export function extractToolPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? [input] : []
  const o = input as Record<string, unknown>
  const out: string[] = []
  for (const k of ['file_path', 'path', 'filePath', 'notebook_path']) {
    if (typeof o[k] === 'string') out.push(o[k] as string)
  }
  for (const k of ['cmd', 'command']) {
    const v = o[k]
    if (typeof v === 'string') {
      out.push(v)
      for (const tok of v.split(/[\s"'`()]+/)) if (tok) out.push(tok)
    }
  }
  return out
}

export interface RedactResult {
  text: string
  redacted: boolean
}

// 逐行屏蔽密钥标记。
export function redactSecrets(text: string): RedactResult {
  if (!text) return { text, redacted: false }
  let redacted = false
  const lines = text.split('\n').map((line) => {
    if (SECRET_MARKERS.some((re) => re.test(line))) {
      redacted = true
      return '[已屏蔽:疑似密钥内容]'
    }
    return line
  })
  return { text: lines.join('\n'), redacted }
}

// tool_result 落盘/回显前过滤:输入路径敏感 → 整体屏蔽;否则按行屏蔽密钥。
export function filterToolResult(
  output: string,
  toolInput: unknown,
): RedactResult {
  const paths = extractToolPaths(toolInput)
  if (paths.some(isSensitivePath)) {
    return { text: '[已屏蔽敏感内容:工具访问了敏感路径]', redacted: true }
  }
  return redactSecrets(output)
}
