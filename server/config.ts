import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

// 只读数据源根目录。
export const CLAUDE_PROJECTS_ROOT = path.join(HOME, '.claude', 'projects')
export const CODEX_SESSIONS_ROOT = path.join(HOME, '.codex', 'sessions')
export const CODEX_SESSION_INDEX = path.join(HOME, '.codex', 'session_index.jsonl')
export const OPENCODE_DATA_ROOT = path.join(HOME, '.local', 'share', 'opencode')
export const OPENCODE_DB_PATH = path.join(OPENCODE_DATA_ROOT, 'opencode.db')

// cockpit 自己的数据(可删可重建)。
export const COCKPIT_ROOT = path.join(HOME, '.cockpit')
export const COCKPIT_THREADS_ROOT = path.join(COCKPIT_ROOT, 'threads')
export const COCKPIT_GROUP_THREADS_ROOT = path.join(COCKPIT_ROOT, 'group-threads')
export const COCKPIT_CACHE_ROOT = path.join(COCKPIT_ROOT, 'cache')
export const COCKPIT_HANDOFFS_ROOT = path.join(COCKPIT_ROOT, 'handoffs')
export const COCKPIT_RUNTIME_LINKS_ROOT = path.join(COCKPIT_ROOT, 'runtime-links')

// 路径穿越白名单根目录(不变量 13)。任何 resolve 出的 filePath 必须 startsWith 其中之一。
export const ALLOWED_ROOTS = [CLAUDE_PROJECTS_ROOT, CODEX_SESSIONS_ROOT, OPENCODE_DATA_ROOT, COCKPIT_ROOT]
