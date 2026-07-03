import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { COCKPIT_GROUP_THREADS_ROOT } from '../config'
import { readJsonlLines } from '../util/jsonl'
import { cleanTitle } from '../util/title'
import type { AgentName, EventEnvelope, NormalizedEvent, SessionSummary } from '../loaders/types'

export interface GroupThreadState {
  id: string
  kind: 'group-chat'
  title: string
  cwd: string | null
  agents: AgentName[]
  startedAt: string
  updatedAt: string
  summaryUpdatedAt: string | null
  summaryRevision: number
}

const TOP_KEYS = ['origin', 'source', 'sourceEventId', 'parentEventId', 'turnId', 'runId'] as const

export function groupThreadDir(id: string): string {
  return path.join(COCKPIT_GROUP_THREADS_ROOT, id)
}

export function groupStateFile(id: string): string {
  return path.join(groupThreadDir(id), 'state.json')
}

export function groupTranscriptFile(id: string): string {
  return path.join(groupThreadDir(id), 'transcript.jsonl')
}

export function groupSummaryFile(id: string): string {
  return path.join(groupThreadDir(id), 'summary.md')
}

export function groupAttachmentsDir(id: string): string {
  return path.join(groupThreadDir(id), 'attachments')
}

function flatLine(env: EventEnvelope): string {
  const flat: Record<string, unknown> = {
    origin: env.origin,
    source: env.source,
    sourceEventId: env.sourceEventId,
    parentEventId: env.parentEventId,
    turnId: env.turnId,
    runId: env.runId,
    ...env.event,
  }
  for (const k of Object.keys(flat)) if (flat[k] === undefined) delete flat[k]
  return JSON.stringify(flat) + '\n'
}

function envelopeFromFlatLine(o: Record<string, unknown>): EventEnvelope | null {
  const rest: Record<string, unknown> = { ...o }
  for (const k of TOP_KEYS) delete rest[k]
  if (typeof rest.type !== 'string') return null
  return {
    origin: 'cockpit',
    source: 'cockpit',
    sourceEventId: typeof o.sourceEventId === 'string' ? o.sourceEventId : undefined,
    parentEventId: typeof o.parentEventId === 'string' ? o.parentEventId : undefined,
    turnId: typeof o.turnId === 'string' ? o.turnId : undefined,
    runId: typeof o.runId === 'string' ? o.runId : undefined,
    event: rest as unknown as NormalizedEvent,
  }
}

const queues = new Map<string, Promise<unknown>>()

function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(id) ?? Promise.resolve()
  const next = prev.then(task, task)
  queues.set(
    id,
    next.catch(() => {}),
  )
  return next
}

function defaultSummary(): string {
  return [
    '# Shared Summary',
    '',
    '## Goal',
    '',
    '## Decisions',
    '',
    '## Open Questions',
    '',
    '## Tasks',
    '',
    '## File State',
    '',
    '## Agent Notes',
    '',
  ].join('\n')
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeState(state: GroupThreadState): Promise<void> {
  await fsp.mkdir(groupThreadDir(state.id), { recursive: true })
  await fsp.writeFile(groupStateFile(state.id), JSON.stringify(state, null, 2) + '\n', 'utf8')
}

async function countTranscript(id: string): Promise<number> {
  let n = 0
  for await (const _ of readJsonlLines(groupTranscriptFile(id))) n++
  return n
}

async function touchState(id: string, patch: Partial<GroupThreadState> = {}): Promise<void> {
  const state = await groupThreadStore.readState(id)
  if (!state) return
  await writeState({ ...state, ...patch, updatedAt: new Date().toISOString() })
}

export const groupThreadStore = {
  async create(input: { title?: string; cwd?: string | null; agents?: AgentName[] } = {}) {
    const id = randomUUID()
    const now = new Date().toISOString()
    const agents = input.agents?.length
      ? [...new Set(input.agents)]
      : (['claude', 'codex', 'opencode', 'cursor'] as AgentName[])
    const state: GroupThreadState = {
      id,
      kind: 'group-chat',
      title: input.title?.trim() || 'Group Chat',
      cwd: input.cwd ?? null,
      agents,
      startedAt: now,
      updatedAt: now,
      summaryUpdatedAt: null,
      summaryRevision: 0,
    }
    await writeState(state)
    await fsp.writeFile(groupTranscriptFile(id), '', 'utf8')
    await fsp.writeFile(groupSummaryFile(id), defaultSummary(), 'utf8')
    return state
  },

  readState(id: string): Promise<GroupThreadState | null> {
    return readJsonFile<GroupThreadState>(groupStateFile(id))
  },

  async update(id: string, patch: { title?: string }): Promise<GroupThreadState | null> {
    return enqueue(id, async () => {
      const state = await this.readState(id)
      if (!state) return null
      const title = patch.title?.trim()
      const next: GroupThreadState = {
        ...state,
        ...(title ? { title } : {}),
        updatedAt: new Date().toISOString(),
      }
      await writeState(next)
      return next
    })
  },

  async readSummary(id: string): Promise<string> {
    try {
      return await fsp.readFile(groupSummaryFile(id), 'utf8')
    } catch {
      return defaultSummary()
    }
  },

  async readTranscript(id: string): Promise<EventEnvelope[]> {
    const file = groupTranscriptFile(id)
    if (!fs.existsSync(file)) return []
    const out: EventEnvelope[] = []
    for await (const { parsed } of readJsonlLines(file)) {
      if (parsed === undefined) continue
      const env = envelopeFromFlatLine(parsed as Record<string, unknown>)
      if (env) out.push(env)
    }
    return out
  },

  async appendEvent(id: string, env: EventEnvelope): Promise<number> {
    return enqueue(id, async () => {
      await fsp.mkdir(groupThreadDir(id), { recursive: true })
      const index = await countTranscript(id)
      await fsp.appendFile(groupTranscriptFile(id), flatLine(env), 'utf8')
      await touchState(id)
      return index
    })
  },

  appendTurnStatus(
    id: string,
    turnId: string,
    runId: string,
    agent: AgentName,
    baseEventSeq: number,
    status: 'completed' | 'failed' | 'aborted',
    message?: string,
  ) {
    return this.appendEvent(id, {
      origin: 'cockpit',
      source: 'cockpit',
      sourceEventId: `status:${turnId}:${runId}:${status}`,
      turnId,
      runId,
      event: {
        type: 'meta',
        key: 'turn_status',
        value: { groupTurnId: turnId, runId, agent, baseEventSeq, status, ...(message ? { message } : {}) },
        ts: new Date().toISOString(),
      },
    })
  },

  async discover(): Promise<SessionSummary[]> {
    let entries: string[] = []
    try {
      entries = await fsp.readdir(COCKPIT_GROUP_THREADS_ROOT)
    } catch {
      return []
    }
    const out: SessionSummary[] = []
    for (const id of entries) {
      const state = await this.readState(id)
      if (!state || state.kind !== 'group-chat') continue
      const transcript = groupTranscriptFile(id)
      let st: { mtimeMs: number; size: number } = { mtimeMs: 0, size: 0 }
      try {
        const s = await fsp.stat(transcript)
        st = { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        /* empty thread */
      }
      const messageCount = await countTranscript(id).catch(() => 0)
      const events = state.title ? [] : await this.readTranscript(id)
      const firstUser = events.find((e) => e.event.type === 'user_text')
      const fallbackTitle =
        firstUser?.event.type === 'user_text' ? cleanTitle(firstUser.event.text) : ''
      out.push({
        id,
        source: 'cockpit',
        title: state.title || fallbackTitle || 'Group Chat',
        cwd: state.cwd,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        messageCount,
        filePath: transcript,
        fileMtimeMs: st.mtimeMs,
        fileSize: st.size,
        hasFollowups: false,
        extensions: { kind: 'group-chat', agents: state.agents },
      })
    }
    return out
  },

  async delete(id: string): Promise<void> {
    await enqueue(id, async () => {
      await fsp.rm(groupThreadDir(id), { recursive: true, force: true })
    })
  },
}
