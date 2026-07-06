import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { COCKPIT_ROOT } from '../config'
import { readJsonlLines } from '../util/jsonl'
import type { AgentName, Source } from '../loaders/types'
import type { RunPermissions } from '../permissions/types'

export type RunKind = 'followup' | 'native-resume' | 'group-member' | 'native-continuation'
export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'

export interface RunRecord {
  runId: string
  kind: RunKind
  status: RunStatus
  source?: Source
  sessionId?: string
  groupThreadId?: string
  turnId: string
  parentTurnId?: string
  agent: AgentName
  permissions?: RunPermissions
  startedAt: string
  endedAt?: string
  error?: string
}

const RUNS_ROOT = path.join(COCKPIT_ROOT, 'runs')
const INDEX_FILE = path.join(RUNS_ROOT, 'index.jsonl')

const queue: { current: Promise<void> } = { current: Promise.resolve() }

function enqueue(task: () => Promise<void>): Promise<void> {
  const next = queue.current.then(task, task)
  queue.current = next.catch(() => {})
  return next
}

export const runStore = {
  indexFile: INDEX_FILE,

  async append(record: RunRecord): Promise<void> {
    await enqueue(async () => {
      await fsp.mkdir(RUNS_ROOT, { recursive: true })
      await fsp.appendFile(INDEX_FILE, JSON.stringify(record) + '\n', 'utf8')
    })
  },

  async readLatest(): Promise<Map<string, RunRecord>> {
    const out = new Map<string, RunRecord>()
    if (!fs.existsSync(INDEX_FILE)) return out
    for await (const { parsed } of readJsonlLines(INDEX_FILE)) {
      if (!parsed || typeof parsed !== 'object') continue
      const record = parsed as RunRecord
      if (typeof record.runId !== 'string') continue
      out.set(record.runId, record)
    }
    return out
  },

  async markInterruptedOnStartup(): Promise<void> {
    const latest = await this.readLatest()
    const now = new Date().toISOString()
    for (const record of latest.values()) {
      if (record.status !== 'running') continue
      await this.append({
        ...record,
        status: 'interrupted',
        endedAt: now,
        error: 'Cockpit process exited before this run finished.',
      })
    }
  },
}
