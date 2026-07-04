// OpenCode adapter uses `opencode run --format json` so Cockpit can consume raw events.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { NormalizedEvent } from '../loaders/types'
import { commandExists } from './cli-utils'
import { normalizeJsonCliEvent } from './json-cli-events'
import { serializeForAgent } from './serialize'
import type { AgentRunInput, ReviewAgent } from './types'
import { openCodePermissionArgs } from '../permissions/adapter-policy'

async function* runOpenCode(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
  const prompt = serializeForAgent(input.contextEvents, input.text, 'opencode')
  const cwd = input.cwd ?? process.cwd()
  const args = [
    'run',
    '--format',
    'json',
    '--dir',
    cwd,
    ...openCodePermissionArgs(input.permissions),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--variant', input.effort] : []),
    prompt,
  ]

  const child = spawn('opencode', args, {
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
      for (const ev of normalizeJsonCliEvent(parsed, 'opencode')) yield ev
    } catch {
      plain += `${line}\n`
    }
  }

  if (plain.trim()) {
    yield { type: 'assistant_text', text: plain.trim(), ts: new Date().toISOString(), agent: 'opencode' }
  }

  const code: number = await new Promise((resolve) => {
    if (child.exitCode != null) return resolve(child.exitCode)
    child.on('close', (c) => resolve(c ?? 0))
  })

  if (input.signal.aborted) throw new Error('aborted')
  if (code !== 0) throw new Error(stderr.trim() || `opencode exited ${code}`)
}

export const opencodeAdapter: ReviewAgent = {
  name: 'opencode',

  async isAvailable() {
    return commandExists('opencode', ['--version'])
  },

  async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
    yield* runOpenCode(input)
  },
}
