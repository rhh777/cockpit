import type { AgentName } from './types'

export interface FallbackModelOption {
  value: string
  label: string
}

// These are CLI-accepted fallbacks only. Account-scoped discovery replaces
// them whenever the corresponding CLI exposes a machine-readable model list.
export const FALLBACK_MODEL_OPTIONS: Record<AgentName, FallbackModelOption[]> = {
  claude: [
    { value: 'fable', label: 'Fable 5' },
    { value: 'opus', label: 'Opus 5' },
    { value: 'sonnet', label: 'Sonnet 5' },
    { value: 'haiku', label: 'Haiku 4.5' },
    { value: 'claude-opus-4-8', label: 'Opus 4.8' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  ],
  opencode: [
    { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet' },
    { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
    { value: 'qwen/qwen3-coder-plus', label: 'Qwen Coder' },
  ],
  cursor: [
    { value: 'auto', label: 'Auto' },
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet' },
  ],
}
