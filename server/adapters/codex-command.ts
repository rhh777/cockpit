// Codex CLI 二进制路径解析。抽出来给 codex-call.ts 和 codex-app-server.ts 共用。
import { commandExists } from './cli-utils'

const CODEX_COMMAND_CANDIDATES = [
  process.env.CODEX_BIN,
  process.env.HOME ? `${process.env.HOME}/.codex/plugins/.plugin-appserver/codex` : undefined,
  '/Applications/work/Codex.app/Contents/Resources/codex',
  'codex',
].filter((v): v is string => !!v)

let resolved: Promise<string | null> | null = null

export async function resolveCodexCommand(): Promise<string | null> {
  if (resolved) return resolved
  const p = (async () => {
    for (const candidate of CODEX_COMMAND_CANDIDATES) {
      if (await commandExists(candidate, ['--version'])) return candidate
    }
    return null
  })()
  resolved = p
  const found = await p
  if (!found) resolved = null // 失败不缓存
  return found
}
