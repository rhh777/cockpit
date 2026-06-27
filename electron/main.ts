import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } from 'electron'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { cockpitApi } from '../server/index'

// Electron 主进程:dev 模式直接指向 vite (localhost:5173);
// 生产模式启动内置 http server (随机端口) 同时提供 /api/* 和静态资源。
// 不变量保持:进程仍只读原生 CLI 文件,cockpit 自身数据落 ~/.cockpit/。

declare const __dirname: string

const isDev = !app.isPackaged
const DEV_URL = 'http://localhost:5173'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let backend: Server | null = null
let backendUrl = ''
let isQuitting = false

async function startBackend(): Promise<string> {
  const api = cockpitApi()
  const server = createServer((req, res) => {
    api(req, res, () => serveStatic(req, res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('failed to bind backend')
  backend = server
  return `http://127.0.0.1:${addr.port}`
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const distDir = path.join(__dirname, '../dist')
  const rawPath = (req.url ?? '/').split('?')[0]
  const requested = path.join(distDir, rawPath === '/' ? '/index.html' : rawPath)
  const resolved = path.resolve(requested)
  if (!resolved.startsWith(path.resolve(distDir))) {
    res.statusCode = 403
    res.end('forbidden')
    return
  }
  let filePath = resolved
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html') // SPA fallback
  }
  const ext = path.extname(filePath).toLowerCase()
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  }
  res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
  fs.createReadStream(filePath).pipe(res)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'cockpit',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (e) => {
    // Tray 常驻:关闭按钮只隐藏窗口,真退出走 menu / before-quit
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const url = isDev ? DEV_URL : backendUrl
  mainWindow.loadURL(url)
}

function toggleWindow() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png')
  let image: Electron.NativeImage = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('cockpit')
  if (image.isEmpty()) tray.setTitle('✈︎')

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏 cockpit', click: toggleWindow },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.on('click', toggleWindow)
}

function registerIpc() {
  ipcMain.handle('cockpit:pick-files', async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('cockpit:pick-directory', async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return result.filePaths
  })
}

app.whenReady().then(async () => {
  if (!isDev) backendUrl = await startBackend()
  registerIpc()
  createTray()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

// Tray 常驻:关闭所有窗口不退出
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  isQuitting = true
  backend?.close()
})
