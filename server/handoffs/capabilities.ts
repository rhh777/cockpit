// docs/07 Phase 3:handoff 能力检测。用于告诉 UI 目标 provider 支持哪些入口。
//
// - codex: CLI 存在即认为 deeplink / cli / app-server 可用(app-server 需要更新的
//   codex 版本,但没有独立版本探测口子;实际不可用时 open-native 会返 502)。
// - claude: CLI 存在时 cli 可用;deeplink 只当 prompt 足够短才可用,由 open-native 侧算。

import { resolveAgent } from '../adapters/registry'

export interface ProviderCapabilities {
  provider: 'codex' | 'claude'
  cliAvailable: boolean
  supportsDeeplink: boolean
  supportsAppServer: boolean
  supportsCli: boolean
  supportsManual: boolean
}

export interface HandoffCapabilities {
  codex: ProviderCapabilities
  claude: ProviderCapabilities
}

export async function detectHandoffCapabilities(): Promise<HandoffCapabilities> {
  const [codexAvailable, claudeAvailable] = await Promise.all([
    resolveAgent('codex').isAvailable().catch(() => false),
    resolveAgent('claude').isAvailable().catch(() => false),
  ])
  return {
    codex: {
      provider: 'codex',
      cliAvailable: codexAvailable,
      supportsDeeplink: true, // 通过 codex:// URL scheme,不依赖本机
      supportsAppServer: codexAvailable,
      supportsCli: codexAvailable,
      supportsManual: true,
    },
    claude: {
      provider: 'claude',
      cliAvailable: claudeAvailable,
      // Claude Desktop 的 URL scheme 未在所有版本稳定,默认关掉;Phase 3 保守。
      supportsDeeplink: false,
      supportsAppServer: false,
      supportsCli: claudeAvailable,
      supportsManual: true,
    },
  }
}
