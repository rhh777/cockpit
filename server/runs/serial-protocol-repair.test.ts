// docs/13 接力讨论 orchestrator 的端到端测试:注册脚本化 agent 顶掉真实 CLI,
// 跑真实的 startGroupTurn(mode='serial') 全流程,再按 transcript 断言。
//
// 重点覆盖「协议修复」路径(docs/13 §解析优先级 6):agent 漏写末尾协议块时
// 先补问一次,而不是直接终止整场讨论。

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import type { AgentName, EventEnvelope, NormalizedEvent } from '../loaders/types'
import type { AgentRunInput, ReviewAgent } from '../adapters/types'
import { registerAgent, resolveAgent } from '../adapters/registry'
import { groupThreadDir, groupThreadStore } from '../store/group-thread-store'
import { DEFAULT_RUN_PERMISSIONS } from '../permissions/types'
import { runRegistry } from './run-registry'

const REPAIR_MARKER = 'missing a valid protocol block'
const createdIds = new Set<string>()
const realAgents = new Map<AgentName, ReviewAgent>()

for (const name of ['claude', 'codex'] as AgentName[]) realAgents.set(name, resolveAgent(name))

after(async () => {
  for (const [, agent] of realAgents) registerAgent(agent)
  await Promise.all([...createdIds].map((id) => fsp.rm(groupThreadDir(id), { recursive: true, force: true })))
})

interface Invocation {
  text: string
  useTools: boolean
  isRepair: boolean
}

/** 按调用序返回脚本化回复;同时记录每次收到的 input,便于断言 useTools 等。 */
function scriptAgent(name: AgentName, reply: (call: Invocation, index: number) => string) {
  const calls: Invocation[] = []
  const agent: ReviewAgent = {
    name,
    displayName: name,
    async isAvailable() {
      return true
    },
    async *run(input: AgentRunInput): AsyncGenerator<NormalizedEvent> {
      const call: Invocation = {
        text: input.text,
        useTools: input.useTools !== false,
        isRepair: input.text.includes(REPAIR_MARKER),
      }
      calls.push(call)
      yield {
        type: 'assistant_text',
        text: reply(call, calls.length - 1),
        ts: new Date().toISOString(),
        agent: name,
      }
    },
  }
  registerAgent(agent)
  return calls
}

function metaEvents(transcript: EventEnvelope[], key: string) {
  return transcript.filter((env) => env.event.type === 'meta' && env.event.key === key)
}

function metaValue(env: EventEnvelope): Record<string, unknown> {
  return (env.event.type === 'meta' ? (env.event.value as Record<string, unknown>) : {}) ?? {}
}

function assistantTextsByAgent(transcript: EventEnvelope[], agent: AgentName): string[] {
  return transcript
    .filter((env) => env.event.type === 'assistant_text' && env.event.agent === agent)
    .map((env) => (env.event.type === 'assistant_text' ? env.event.text : ''))
}

/** 等 orchestrator 写出 serial_turn_status(它在后台跑,startGroupTurn 只返回首个 run)。 */
async function waitForTurnStatus(id: string, timeoutMs = 15000): Promise<EventEnvelope> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const transcript = await groupThreadStore.readTranscript(id)
    const status = metaEvents(transcript, 'serial_turn_status')[0]
    if (status) return status
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out waiting for serial_turn_status')
}

async function runSerialTurn(maxSteps = 4) {
  const state = await groupThreadStore.create({ agents: ['claude', 'codex'] as AgentName[] })
  createdIds.add(state.id)
  await runRegistry.startGroupTurn({
    id: state.id,
    text: 'discuss the cache design',
    targetAgents: ['claude'] as AgentName[],
    mode: 'serial',
    serial: {
      participants: ['claude', 'codex'] as AgentName[],
      firstAgent: 'claude' as AgentName,
      maxSteps,
      stopOnConsensus: true,
    },
    useTools: true,
    permissions: { ...DEFAULT_RUN_PERMISSIONS },
  })
  const status = await waitForTurnStatus(state.id)
  return { id: state.id, status, transcript: await groupThreadStore.readTranscript(state.id) }
}

test('serial: 缺协议块时补问一次,拿到 Next 后讨论继续', async () => {
  const claudeCalls = scriptAgent('claude', (call) =>
    call.isRepair ? 'Next: @codex\nStatus: needs-review' : '架构上我担心缓存失效边界。(忘了写协议块)',
  )
  const codexCalls = scriptAgent('codex', () => '实现看过了,同意。\n\nNext: @user\nStatus: consensus')

  const { status, transcript } = await runSerialTurn()

  const repairs = metaEvents(transcript, 'serial_protocol_repair')
  assert.equal(repairs.length, 1, '应只补问一次')
  assert.equal(metaValue(repairs[0]).agent, 'claude')
  assert.equal(metaValue(repairs[0]).reason, 'protocol-missing')

  // 补问成功后 codex 真的接棒了,讨论没有被一次格式失误终止。
  assert.equal(codexCalls.length, 1)
  assert.equal(metaValue(status).reason, 'consensus')
  assert.equal(metaValue(status).status, 'completed')

  // claude 被调两次:1 次正常发言 + 1 次补协议。
  assert.equal(claudeCalls.length, 2)
  assert.equal(claudeCalls[0].isRepair, false)
  assert.equal(claudeCalls[1].isRepair, true)
})

test('serial: 补问不占发言预算', async () => {
  scriptAgent('claude', (call) => (call.isRepair ? 'Next: @codex\nStatus: needs-review' : '没写协议'))
  scriptAgent('codex', () => 'ok\n\nNext: @user\nStatus: consensus')

  const { status } = await runSerialTurn()
  // claude + codex = 2 次发言;补协议那次不计入 steps。
  assert.equal(metaValue(status).steps, 2)
})

test('serial: 补问后仍缺协议 → protocol-missing 终止,且只补问一次', async () => {
  const claudeCalls = scriptAgent('claude', () => '我就是不写协议块。')
  const codexCalls = scriptAgent('codex', () => 'Next: @user\nStatus: consensus')

  const { status, transcript } = await runSerialTurn()

  assert.equal(metaEvents(transcript, 'serial_protocol_repair').length, 1, '不能反复补问')
  assert.equal(claudeCalls.length, 2, '1 次发言 + 1 次补问,不能无限重试')
  assert.equal(codexCalls.length, 0, '协议始终缺失,不该有人接棒')
  assert.equal(metaValue(status).reason, 'protocol-missing')
  assert.equal(metaValue(status).status, 'failed')
})

test('serial: 补协议请求不带工具权限', async () => {
  const claudeCalls = scriptAgent('claude', (call) =>
    call.isRepair ? 'Next: @codex\nStatus: needs-review' : '缺协议',
  )
  scriptAgent('codex', () => 'ok\n\nNext: @user\nStatus: consensus')

  await runSerialTurn()

  assert.equal(claudeCalls[0].useTools, true, '正常发言沿用 turn 的 useTools')
  assert.equal(claudeCalls[1].useTools, false, '补协议只要两行文本,不该开工具')
})

test('serial: 补协议请求要求只补协议、不要重答', async () => {
  const claudeCalls = scriptAgent('claude', (call) =>
    call.isRepair ? 'Next: @codex\nStatus: needs-review' : '缺协议',
  )
  scriptAgent('codex', () => 'ok\n\nNext: @user\nStatus: consensus')

  await runSerialTurn()

  const repairPrompt = claudeCalls[1].text
  assert.match(repairPrompt, /Do not repeat, revise, or extend your analysis/)
  // 合法目标里有对端和 @user,但不含自己(selectNextAgentFromDirective 会拒 next === current)。
  assert.match(repairPrompt, /@codex/)
  assert.match(repairPrompt, /@user/)
  assert.doesNotMatch(repairPrompt, /Valid Next targets:[^\n]*@claude/)
})

test('serial: 协议齐全时不触发补问', async () => {
  const claudeCalls = scriptAgent('claude', () => '架构看完了。\n\nNext: @codex\nStatus: needs-review')
  scriptAgent('codex', () => '实现也看完了。\n\nNext: @user\nStatus: consensus')

  const { status, transcript } = await runSerialTurn()

  assert.equal(metaEvents(transcript, 'serial_protocol_repair').length, 0)
  assert.equal(claudeCalls.length, 1)
  assert.equal(metaValue(status).reason, 'consensus')
  assert.equal(assistantTextsByAgent(transcript, 'codex').length, 1)
})
