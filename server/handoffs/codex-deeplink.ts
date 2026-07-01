// Codex deep link builder。docs/07 §Codex 实现.
// codex://threads/new?path=<cwd>&prompt=<short prompt>
//
// prompt 必须足够短(避免超过 OS URL 长度)。docs/07 给的阈值是 encodeURIComponent(prompt).length > 1800。
// 这里直接构造 prompt 指向 handoff.codex.md,绝对路径,不嵌入 transcript。

import type { HandoffManifest } from './types'

export const CODEX_PROMPT_BUDGET = 1800

export interface CodexDeeplinkResult {
  url: string
  prompt: string
  promptEncodedLength: number
  overBudget: boolean
}

export function buildCodexDeeplink(manifest: HandoffManifest): CodexDeeplinkResult {
  const cwd = manifest.cwd ?? ''
  const entry = manifest.files.entries.codex
  const prompt = [
    'Please continue from this Cockpit handoff.',
    '',
    'Read:',
    entry,
    ...(cwd ? ['', 'Workspace:', cwd] : []),
  ].join('\n')

  const encodedPrompt = encodeURIComponent(prompt)
  const encodedPath = encodeURIComponent(cwd)
  const url = `codex://threads/new?path=${encodedPath}&prompt=${encodedPrompt}`
  return {
    url,
    prompt,
    promptEncodedLength: encodedPrompt.length,
    overBudget: encodedPrompt.length > CODEX_PROMPT_BUDGET,
  }
}
