// 把 electron/ 下的运行时静态资源拷进 dist-electron/。
// 用 node 而不是 shell 的 cp:pnpm 在 Windows 上经 cmd.exe 执行脚本,没有 cp。
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'dist-electron')
const assets = ['tray-icon.png', 'tray-icon@2x.png']

mkdirSync(outDir, { recursive: true })
for (const name of assets) {
  copyFileSync(join(root, 'electron', name), join(outDir, name))
}
