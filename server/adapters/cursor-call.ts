// Cursor adapter uses the headless `cursor-agent`/`agent` CLI in ask mode for read-only follow-ups.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { NormalizedEvent } from '../loaders/types'
import { commandExists } from './cli-utils'
import { normalizeJsonCliEvent } from './json-cli-events'
import { serializeForAgent } from './serialize'
import type { AgentRunInput, ReviewAgent } from './types'

async function resolveCursorCommand(): Promise<string | null> {
  if (await commandExists('cursor-agent', ['--version'])) return 'cursor-agent'
  if (await commandExists('agent', ['--version'])) return 'agent'
  return null
}

async function* runCursor(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
  const cursor = await resolveCursorCommand()
  if (!cursor) throw new Error('Cursor CLI 不可用(未检测到 cursor-agent 或 agent)')

  const prompt = serializeForAgent(input.contextEvents, input.text, 'cursor')
  const cwd = input.cwd ?? process.cwd()
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--mode',
    'ask',
    ...(input.model ? ['--model', input.model] : []),
    prompt,
  ]

  const child = spawn(cursor, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: input.signal,
  })

  let stderr = ''
  let plain = ''
  child.stderr.on('data', (d) => (stderr += String(d)))

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Record<string, any>
      for (const ev of normalizeJsonCliEvent(parsed, 'cursor')) yield ev
    } catch {
      plain += `${line}\n`
    }
  }

  if (plain.trim()) {
    yield { type: 'assistant_text', text: plain.trim(), ts: new Date().toISOString(), agent: 'cursor' }
  }

  const code: number = await new Promise((resolve) => {
    if (child.exitCode != null) return resolve(child.exitCode)
    child.on('close', (c) => resolve(c ?? 0))
  })

  if (input.signal.aborted) throw new Error('aborted')
  if (code !== 0) throw new Error(stderr.trim() || `cursor exited ${code}`)
}

export const cursorAdapter: ReviewAgent = {
  name: 'cursor',

  async isAvailable() {
    return (await resolveCursorCommand()) !== null
  },

  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    yield* runCursor(input)
  },
}

