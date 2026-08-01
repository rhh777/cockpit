import { claudeLoader } from './claude-loader'
import { codexLoader } from './codex-loader'
import { cockpitLoader } from './cockpit-loader'
import { opencodeLoader } from './opencode-loader'
import { cursorLoader } from './cursor-loader'
import type { SessionSourceLoader } from './types'

// 所有来源 loader 在此注册。新增来源只加一行,其它层不动(不变量 9)。
export const loaders: SessionSourceLoader[] = [claudeLoader, codexLoader, opencodeLoader, cursorLoader, cockpitLoader]

export const loaderBySource = new Map<string, SessionSourceLoader>(
  loaders.map((l) => [l.source, l]),
)
