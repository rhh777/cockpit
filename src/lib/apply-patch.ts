// Codex apply_patch envelope 解析。
// 格式(见 ~/.codex/sessions/.../custom_tool_call payload.input):
//   *** Begin Patch
//   *** Update File: <path>
//   [*** Move to: <new path>]
//   @@                   ← hunk 分隔(可选 hunk 注释跟在 @@ 后)
//    context line
//   -removed line
//   +added line
//   *** Add File: <path>
//   +line1
//   +line2
//   *** Delete File: <path>
//   *** End Patch

export type LineKind = '+' | '-' | ' '
export interface PatchLine {
  kind: LineKind
  text: string
}
export interface PatchHunk {
  header?: string
  lines: PatchLine[]
}
export type PatchFileKind = 'update' | 'add' | 'delete'
export interface PatchFile {
  kind: PatchFileKind
  path: string
  movedTo?: string
  hunks: PatchHunk[]
  adds: number
  dels: number
}

export function parseApplyPatch(input: unknown): PatchFile[] | null {
  if (typeof input !== 'string') return null
  if (!input.includes('*** Begin Patch')) return null

  const lines = input.split('\n')
  const files: PatchFile[] = []
  let cur: PatchFile | null = null
  let hunk: PatchHunk | null = null

  const finishFile = () => {
    if (cur) files.push(cur)
    cur = null
    hunk = null
  }

  for (const line of lines) {
    if (line === '*** Begin Patch' || line === '*** End Patch') continue

    if (line.startsWith('*** Update File: ')) {
      finishFile()
      cur = {
        kind: 'update',
        path: line.slice('*** Update File: '.length),
        hunks: [],
        adds: 0,
        dels: 0,
      }
    } else if (line.startsWith('*** Add File: ')) {
      finishFile()
      cur = {
        kind: 'add',
        path: line.slice('*** Add File: '.length),
        hunks: [{ lines: [] }],
        adds: 0,
        dels: 0,
      }
      hunk = cur.hunks[0]
    } else if (line.startsWith('*** Delete File: ')) {
      finishFile()
      cur = {
        kind: 'delete',
        path: line.slice('*** Delete File: '.length),
        hunks: [],
        adds: 0,
        dels: 0,
      }
    } else if (line.startsWith('*** Move to: ')) {
      if (cur) cur.movedTo = line.slice('*** Move to: '.length)
    } else if (line.startsWith('@@')) {
      if (!cur) continue
      const header = line.slice(2).trim()
      hunk = { header: header || undefined, lines: [] }
      cur.hunks.push(hunk)
    } else if (cur) {
      // Add File 也走这里(没有 @@),hunk 已在上面初始化。
      if (!hunk) {
        // Update File 没显式 @@ 就出现内容:容错初始化一个 hunk。
        hunk = { lines: [] }
        cur.hunks.push(hunk)
      }
      const c = line[0]
      let kind: LineKind = ' '
      let text = line
      if (c === '+' || c === '-' || c === ' ') {
        kind = c as LineKind
        text = line.slice(1)
      }
      hunk.lines.push({ kind, text })
      if (kind === '+') cur.adds++
      else if (kind === '-') cur.dels++
    }
  }
  finishFile()
  return files
}

/** 把绝对路径裁成相对感更强的尾段(保留最后两段)。 */
export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}
