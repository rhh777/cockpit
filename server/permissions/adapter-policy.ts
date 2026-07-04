import type { RunPermissions } from './types'

export function codexSandboxForPermissions(permissions?: RunPermissions): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (permissions?.mode === 'full-access') return 'danger-full-access'
  if (permissions?.mode === 'auto-safe') return 'workspace-write'
  return 'read-only'
}

export function codexGlobalArgsForPermissions(permissions?: RunPermissions): string[] {
  if (permissions?.mode === 'full-access') return ['--dangerously-bypass-approvals-and-sandbox', '--search']
  if (permissions?.mode === 'auto-safe') return ['--ask-for-approval', 'untrusted', '--search']
  return ['--ask-for-approval', 'never']
}

export function claudePermissionArgs(permissions?: RunPermissions, useTools = true): string[] {
  if (!useTools) {
    return [
      '--permission-mode',
      'default',
      '--disallowedTools',
      'Bash,Edit,Write,MultiEdit,WebFetch,WebSearch',
    ]
  }
  if (permissions?.mode === 'full-access') {
    return ['--permission-mode', 'bypassPermissions']
  }
  if (permissions?.mode === 'auto-safe') {
    // acceptEdits: 文件编辑自动通过,shell / MCP 等仍会走 prompt。
    return ['--permission-mode', 'acceptEdits']
  }
  return ['--permission-mode', 'default', '--allowedTools', 'Read,Grep,Glob']
}

export function cursorPermissionArgs(permissions?: RunPermissions): string[] {
  if (permissions?.mode === 'full-access') return ['--force', '--trust', '--sandbox', 'disabled']
  if (permissions?.mode === 'auto-safe') return ['--auto-review', '--trust']
  return ['--mode', 'ask']
}

export function openCodePermissionArgs(permissions?: RunPermissions): string[] {
  if (permissions?.mode === 'full-access') return ['--dangerously-skip-permissions']
  return ['--agent', 'plan']
}
