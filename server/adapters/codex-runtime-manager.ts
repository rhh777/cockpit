import {
  CodexAppServer,
  type CodexApprovalResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './codex-app-server'
import { resolveCodexCommand } from './codex-command'

export interface CodexProcessKey {
  provider: 'codex'
  binaryPath: string
  version?: string
  protocol: 'app-server-stdio'
}

export interface CodexTurnHandlers {
  onNotification(notification: JsonRpcNotification): void
  onServerRequest(request: JsonRpcRequest): void
  onError(error: Error): void
}

export interface CodexRuntimeServer {
  onNotification: ((n: JsonRpcNotification) => void) | null
  onServerRequest: ((r: JsonRpcRequest) => void) | null
  spawn(binaryPath?: string): Promise<void>
  request<T = unknown>(method: string, params: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  respond(id: number | string, response: CodexApprovalResponse): void
  readLoop(): Promise<void>
  kill(): void
}

export interface CodexRuntimeLease {
  key: CodexProcessKey
  server: CodexRuntimeServer
  setHandlers(handlers: CodexTurnHandlers): void
  disposeRuntime(reason?: Error): void
  release(): void
}

interface ActiveTurn {
  token: symbol
  handlers: CodexTurnHandlers
}

interface ManagedSession {
  id: string
  key: CodexProcessKey
  server: CodexRuntimeServer
  status: 'starting' | 'ready' | 'failed' | 'stopped'
  refCount: number
  lastUsedAt: number
  mutex: AsyncMutex
  ready: Promise<void>
  activeTurn: ActiveTurn | null
  readLoop: Promise<void> | null
  error: Error | null
}

interface CodexRuntimeManagerOptions {
  idleMs?: number
  sweepIntervalMs?: number
  autoSweep?: boolean
  createServer?: () => CodexRuntimeServer
  resolveCommand?: () => Promise<string | null>
  now?: () => number
}

const DEFAULT_IDLE_MS = 5 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

class AsyncMutex {
  private locked = false
  private waiters: Array<() => void> = []

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Error('aborted'))
    if (!this.locked) {
      this.locked = true
      return Promise.resolve(this.releaseOnce())
    }

    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal.removeEventListener('abort', onAbort)
        resolve(this.releaseOnce())
      }
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.locked = false
    }
  }
}

export class CodexRuntimeManager {
  private sessions = new Map<string, ManagedSession>()
  private readonly idleMs: number
  private readonly createServer: () => CodexRuntimeServer
  private readonly resolveCommand: () => Promise<string | null>
  private readonly now: () => number
  private readonly sweepTimer: NodeJS.Timeout | null

  constructor(options: CodexRuntimeManagerOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.createServer = options.createServer ?? (() => new CodexAppServer())
    this.resolveCommand = options.resolveCommand ?? resolveCodexCommand
    this.now = options.now ?? Date.now
    if (options.autoSweep ?? true) {
      this.sweepTimer = setInterval(
        () => void this.disposeIdle(),
        options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      )
      this.sweepTimer.unref?.()
    } else {
      this.sweepTimer = null
    }
  }

  async resolveDefaultKey(): Promise<CodexProcessKey> {
    const binaryPath = await this.resolveCommand()
    if (!binaryPath) throw new Error('codex CLI 不可用(本机未安装/登录对应 CLI)')
    return {
      provider: 'codex',
      binaryPath,
      protocol: 'app-server-stdio',
    }
  }

  async warmup(key?: CodexProcessKey): Promise<void> {
    const processKey = key ?? (await this.resolveDefaultKey())
    await this.ensureSession(processKey)
  }

  async acquire(signal: AbortSignal, key?: CodexProcessKey): Promise<CodexRuntimeLease> {
    const processKey = key ?? (await this.resolveDefaultKey())
    const session = await this.ensureSession(processKey)
    session.refCount += 1
    session.lastUsedAt = this.now()

    let unlock: (() => void) | null = null
    try {
      unlock = await session.mutex.acquire(signal)
      if (session.status !== 'ready') {
        throw session.error ?? new Error('codex app-server unavailable')
      }
      return this.createLease(session, unlock)
    } catch (err) {
      if (unlock) unlock()
      session.refCount = Math.max(0, session.refCount - 1)
      session.lastUsedAt = this.now()
      throw err
    }
  }

  async dispose(key: CodexProcessKey): Promise<void> {
    const session = this.sessions.get(this.keyId(key))
    if (session) this.stopSession(session, new Error('codex app-server disposed'))
  }

  async disposeIdle(now = this.now()): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      if (session.refCount > 0) continue
      if (session.status === 'starting') continue
      if (now - session.lastUsedAt >= this.idleMs) {
        this.stopSession(session, new Error('codex app-server idle timeout'))
      }
    }
  }

  async disposeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      this.stopSession(session, new Error('codex app-server disposed'))
    }
    if (this.sweepTimer) clearInterval(this.sweepTimer)
  }

  getSessionSnapshot() {
    return [...this.sessions.values()].map((session) => ({
      key: session.key,
      status: session.status,
      refCount: session.refCount,
      lastUsedAt: session.lastUsedAt,
    }))
  }

  private createLease(session: ManagedSession, unlock: () => void): CodexRuntimeLease {
    const token = Symbol('codex-turn')
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (session.activeTurn?.token === token) session.activeTurn = null
      unlock()
      session.refCount = Math.max(0, session.refCount - 1)
      session.lastUsedAt = this.now()
    }
    return {
      key: session.key,
      server: session.server,
      setHandlers(handlers) {
        if (released) throw new Error('codex runtime lease already released')
        session.activeTurn = { token, handlers }
      },
      disposeRuntime: (reason = new Error('codex app-server runtime disposed')) => {
        this.stopSession(session, reason)
      },
      release,
    }
  }

  private async ensureSession(key: CodexProcessKey): Promise<ManagedSession> {
    const id = this.keyId(key)
    const existing = this.sessions.get(id)
    if (existing && existing.status !== 'failed' && existing.status !== 'stopped') {
      await existing.ready
      return existing
    }
    if (existing) this.sessions.delete(id)

    const session: ManagedSession = {
      id,
      key,
      server: this.createServer(),
      status: 'starting',
      refCount: 0,
      lastUsedAt: this.now(),
      mutex: new AsyncMutex(),
      ready: Promise.resolve(),
      activeTurn: null,
      readLoop: null,
      error: null,
    }
    session.ready = this.startSession(session)
    this.sessions.set(id, session)
    await session.ready
    return session
  }

  private async startSession(session: ManagedSession): Promise<void> {
    const server = session.server
    server.onNotification = (notification) => {
      session.activeTurn?.handlers.onNotification(notification)
    }
    server.onServerRequest = (request) => {
      const active = session.activeTurn
      if (active) {
        active.handlers.onServerRequest(request)
        return
      }
      server.respond(request.id, {
        error: {
          code: -32601,
          message: `No active Cockpit turn for Codex server request: ${request.method}`,
        },
      })
    }

    try {
      await server.spawn(session.key.binaryPath)
      session.readLoop = server.readLoop().then(
        () => {
          if (session.status !== 'stopped') {
            this.failSession(session, new Error('codex app-server stopped'))
          }
        },
        (err) => {
          if (session.status !== 'stopped') {
            this.failSession(session, err instanceof Error ? err : new Error(String(err)))
          }
        },
      )
      await initializeCodexAppServer(server)
      session.status = 'ready'
      session.lastUsedAt = this.now()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.failSession(session, error)
      server.kill()
      throw error
    }
  }

  private failSession(session: ManagedSession, error: Error): void {
    if (session.status === 'stopped') return
    session.status = 'failed'
    session.error = error
    this.sessions.delete(session.id)
    session.activeTurn?.handlers.onError(error)
    session.server.kill()
  }

  private stopSession(session: ManagedSession, reason: Error): void {
    if (session.status === 'stopped') return
    session.status = 'stopped'
    session.error = reason
    this.sessions.delete(session.id)
    session.activeTurn?.handlers.onError(reason)
    session.server.kill()
  }

  private keyId(key: CodexProcessKey): string {
    return JSON.stringify([key.provider, key.binaryPath, key.version ?? '', key.protocol])
  }
}

async function initializeCodexAppServer(server: CodexRuntimeServer): Promise<void> {
  await server.request('initialize', {
    clientInfo: { name: 'cockpit', title: 'Cockpit', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  server.notify('initialized')
}

export const codexRuntimeManager = new CodexRuntimeManager()
