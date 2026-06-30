import fsp from 'node:fs/promises'
import path from 'node:path'
import { COCKPIT_ROOT } from '../config'
import type { EventEnvelope, Source } from '../loaders/types'

const SHADOW_ROOT = path.join(COCKPIT_ROOT, 'runs', 'native-shadow')

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

function safeSegment(s: string): string {
  return encodeURIComponent(s).replace(/%/g, '_')
}

export const nativeShadowStore = {
  file(source: Source, id: string, runId: string): string {
    return path.join(SHADOW_ROOT, safeSegment(source), safeSegment(id), `${safeSegment(runId)}.jsonl`)
  },

  async append(source: Source, id: string, runId: string, env: EventEnvelope): Promise<void> {
    const file = this.file(source, id, runId)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, flatLine(env), 'utf8')
  },
}
