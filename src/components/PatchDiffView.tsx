import { useState } from 'react'
import { parseApplyPatch, shortPath, type PatchFile } from '../lib/apply-patch'

const KIND_LABEL: Record<PatchFile['kind'], string> = {
  update: 'modified',
  add: 'added',
  delete: 'deleted',
}

export function PatchDiffView({ input }: { input: unknown }) {
  const files = parseApplyPatch(input)
  if (!files || files.length === 0) {
    // 解析失败 / 不是 patch → 回退原始文本展示,避免吞数据。
    return <pre className="patch-fallback">{typeof input === 'string' ? input : JSON.stringify(input, null, 2)}</pre>
  }
  return (
    <div className="patch-diff">
      {files.map((f, i) => (
        <PatchFileView key={`${f.path}#${i}`} file={f} />
      ))}
    </div>
  )
}

function PatchFileView({ file }: { file: PatchFile }) {
  const [open, setOpen] = useState(true)
  const isAdd = file.kind === 'add'
  const isDel = file.kind === 'delete'
  return (
    <div className={`patch-file kind-${file.kind}`}>
      <div className="patch-file-head" onClick={() => setOpen((v) => !v)}>
        <span className="patch-toggle">{open ? '▾' : '▸'}</span>
        <span className={`patch-kind kind-${file.kind}`}>{KIND_LABEL[file.kind]}</span>
        <span className="patch-path" title={file.path}>
          {shortPath(file.path)}
        </span>
        {file.movedTo && (
          <span className="patch-moved" title={file.movedTo}>
            → {shortPath(file.movedTo)}
          </span>
        )}
        {!isDel && (
          <span className="patch-stat">
            {file.adds > 0 && <span className="add">+{file.adds}</span>}
            {file.dels > 0 && <span className="del">−{file.dels}</span>}
          </span>
        )}
      </div>
      {open && !isDel && (
        <div className="patch-file-body">
          {file.hunks.map((h, hi) => (
            <div key={hi} className="patch-hunk">
              {h.header && <div className="patch-hunk-header">@@ {h.header}</div>}
              {!h.header && hi > 0 && <div className="patch-hunk-sep">⋯</div>}
              {h.lines.map((ln, li) => (
                <div key={li} className={`patch-line ln-${ln.kind === ' ' ? 'ctx' : ln.kind === '+' ? 'add' : 'del'}`}>
                  <span className="patch-gutter">{ln.kind === ' ' ? ' ' : ln.kind}</span>
                  <span className="patch-text">{ln.text || ' '}</span>
                </div>
              ))}
            </div>
          ))}
          {isAdd && file.hunks[0]?.lines.length === 0 && (
            <div className="patch-empty">(空文件)</div>
          )}
        </div>
      )}
    </div>
  )
}
