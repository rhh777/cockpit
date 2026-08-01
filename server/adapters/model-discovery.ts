import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentModelOption } from './opencode-call'
import { listOpenCodeModels } from './opencode-call'
import { codexRuntimeManager } from './codex-runtime-manager'
import { resolveCursorCommand } from './cursor-call'
import { COCKPIT_CACHE_ROOT } from '../config'

export type DetectionStatus = 'detected' | 'cached' | 'unsupported' | 'failed'

export interface AgentCliCapabilities {
  models: AgentModelOption[]
  modelDetection: { status: DetectionStatus; reason?: string; detail?: string; cachedAt?: string }
  effortDetection: {
    status: DetectionStatus | 'embedded'
    values: string[]
    reason?: string
    detail?: string
  }
}

interface CodexModel {
  id?: string
  model?: string
  displayName?: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: { reasoningEffort?: string }[]
}

interface CodexModelPage {
  data?: CodexModel[]
  nextCursor?: string | null
}

interface CursorModelCache {
  version: 1
  detectedAt: string
  models: AgentModelOption[]
}

const CURSOR_MODEL_CACHE_PATH = path.join(COCKPIT_CACHE_ROOT, 'cursor-models.json')

export function parseCursorModels(output: string): AgentModelOption[] {
  const options: AgentModelOption[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([^\s]+)\s+-\s+(.+?)(?:\s+\(([^)]+)\))?$/)
    if (!match || match[1] === 'Tip:') continue
    options.push({
      value: match[1],
      label: match[2].trim(),
      ...(match[3]?.includes('default') ? { isDefault: true } : {}),
    })
  }
  return options
}

export function parseClaudeEfforts(output: string): string[] {
  const match = output.match(/--effort\s+<[^>]+>[\s\S]{0,180}?\(([^)]+)\)/)
  if (!match) return []
  return match[1].split(',').map((value) => value.trim()).filter(Boolean)
}

function capture(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(stdout)
    }
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', (error) => finish(error))
    child.on('close', (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `${command} exited ${code}`)))
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`${command} model detection timed out`))
    }, timeoutMs)
  })
}

async function writeCursorModelCache(models: AgentModelOption[]): Promise<void> {
  const cache: CursorModelCache = { version: 1, detectedAt: new Date().toISOString(), models }
  await fs.mkdir(COCKPIT_CACHE_ROOT, { recursive: true })
  const temporary = `${CURSOR_MODEL_CACHE_PATH}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 })
  await fs.rename(temporary, CURSOR_MODEL_CACHE_PATH)
}

async function readCursorModelCache(): Promise<CursorModelCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(CURSOR_MODEL_CACHE_PATH, 'utf8')) as Partial<CursorModelCache>
    if (parsed.version !== 1 || !parsed.detectedAt || !Array.isArray(parsed.models) || parsed.models.length === 0) return null
    return parsed as CursorModelCache
  } catch {
    return null
  }
}

async function listCodexCapabilities(): Promise<AgentCliCapabilities> {
  const models: AgentModelOption[] = []
  let cursor: string | null = null
  do {
    const page: CodexModelPage = await codexRuntimeManager.requestMetadata<CodexModelPage>('model/list', {
      cursor,
      limit: 100,
      includeHidden: false,
    })
    for (const model of page.data ?? []) {
      if (model.hidden) continue
      const value = model.model || model.id
      if (!value) continue
      models.push({
        value,
        label: model.displayName || value,
        hint: model.description,
        efforts: (model.supportedReasoningEfforts ?? [])
          .map((entry) => entry.reasoningEffort)
          .filter((effort): effort is string => Boolean(effort)),
        defaultEffort: model.defaultReasoningEffort,
        isDefault: model.isDefault,
      })
    }
    cursor = page.nextCursor ?? null
  } while (cursor)
  return {
    models,
    modelDetection: { status: 'detected' },
    effortDetection: {
      status: 'detected',
      values: [...new Set(models.flatMap((model) => model.efforts ?? []))],
    },
  }
}

async function listClaudeCapabilities(): Promise<AgentCliCapabilities> {
  const help = await capture('claude', ['--help'])
  const efforts = parseClaudeEfforts(help)
  return {
    models: [],
    modelDetection: {
      status: 'unsupported',
      reason: 'claude-model-list-unsupported',
    },
    effortDetection: efforts.length
      ? { status: 'detected', values: efforts }
      : { status: 'failed', values: [], detail: 'Could not parse --effort values from claude --help.' },
  }
}

async function listCursorCapabilities(): Promise<AgentCliCapabilities> {
  const command = await resolveCursorCommand()
  if (!command) throw new Error('Cursor CLI not detected')
  try {
    const output = await capture(command, ['--list-models'])
    const models = parseCursorModels(output)
    if (models.length === 0) throw new Error(output.trim() || 'Cursor returned no models.')
    await writeCursorModelCache(models).catch(() => {})
    return {
      models,
      modelDetection: { status: 'detected' },
      effortDetection: {
        status: 'embedded',
        values: [],
        reason: 'cursor-effort-embedded',
      },
    }
  } catch (error) {
    const cached = await readCursorModelCache()
    if (!cached) throw error
    return {
      models: cached.models,
      modelDetection: {
        status: 'cached',
        reason: 'cursor-model-cache',
        detail: String((error as Error)?.message ?? error),
        cachedAt: cached.detectedAt,
      },
      effortDetection: {
        status: 'embedded',
        values: [],
        reason: 'cursor-effort-embedded',
      },
    }
  }
}

async function listOpenCodeCapabilities(cwd?: string | null): Promise<AgentCliCapabilities> {
  const models = await listOpenCodeModels(cwd)
  return {
    models,
    modelDetection: { status: 'detected' },
    effortDetection: {
      status: 'detected',
      values: [...new Set(models.flatMap((model) => model.efforts ?? []))],
    },
  }
}

export async function discoverAgentCliCapabilities(agent: string, cwd?: string | null): Promise<AgentCliCapabilities> {
  try {
    if (agent === 'codex') return await listCodexCapabilities()
    if (agent === 'opencode') return await listOpenCodeCapabilities(cwd)
    if (agent === 'cursor') return await listCursorCapabilities()
    if (agent === 'claude') return await listClaudeCapabilities()
    return {
      models: [],
      modelDetection: { status: 'unsupported', reason: 'model-list-unsupported' },
      effortDetection: { status: 'unsupported', values: [], reason: 'effort-list-unsupported' },
    }
  } catch (error) {
    const detail = String((error as Error)?.message ?? error)
    return {
      models: [],
      modelDetection: { status: 'failed', detail },
      effortDetection: { status: 'failed', values: [], detail },
    }
  }
}
