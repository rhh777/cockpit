import type { OpencodeClient } from '@opencode-ai/sdk/v2'

type OpenCodeSdkModule = typeof import('@opencode-ai/sdk/v2')

interface OpenCodeRuntime {
  url: string
  close(): void
}

export interface OpenCodeRuntimeLease {
  clientFor(directory: string): OpencodeClient
  release(): void
}

interface ManagedRuntime {
  runtime: OpenCodeRuntime
  sdk: OpenCodeSdkModule
  refCount: number
  lastUsedAt: number
}

interface OpenCodeRuntimeManagerOptions {
  idleMs?: number
  sweepIntervalMs?: number
  autoSweep?: boolean
  now?: () => number
  importSdk?: () => Promise<OpenCodeSdkModule>
}

const DEFAULT_IDLE_MS = 5 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

let sdkPromise: Promise<OpenCodeSdkModule> | null = null
let sdkImporter: () => Promise<OpenCodeSdkModule> = () => {
  // Keep the SDK/server launcher out of Electron's CJS main-process bundle.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<OpenCodeSdkModule>
  return dynamicImport('@opencode-ai/sdk/v2')
}

async function loadOpenCodeSdk(importSdk = sdkImporter): Promise<OpenCodeSdkModule> {
  if (!sdkPromise) {
    sdkPromise = importSdk().catch((err) => {
      sdkPromise = null
      throw err
    })
  }
  return sdkPromise
}

export class OpenCodeRuntimeManager {
  private managed: ManagedRuntime | null = null
  private starting: Promise<ManagedRuntime> | null = null
  private readonly idleMs: number
  private readonly sweepTimer: NodeJS.Timeout | null
  private readonly now: () => number
  private readonly importSdk: () => Promise<OpenCodeSdkModule>

  constructor(options: OpenCodeRuntimeManagerOptions = {}) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.now = options.now ?? Date.now
    this.importSdk = options.importSdk ?? sdkImporter
    if (options.autoSweep ?? true) {
      this.sweepTimer = setInterval(
        () => this.disposeIdle(),
        options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
      )
      this.sweepTimer.unref?.()
    } else {
      this.sweepTimer = null
    }
  }

  async acquire(): Promise<OpenCodeRuntimeLease> {
    const managed = await this.ensureRuntime()
    managed.refCount += 1
    managed.lastUsedAt = this.now()
    let released = false
    return {
      clientFor: (directory) =>
        managed.sdk.createOpencodeClient({
          baseUrl: managed.runtime.url,
          directory,
        }),
      release: () => {
        if (released) return
        released = true
        managed.refCount = Math.max(0, managed.refCount - 1)
        managed.lastUsedAt = this.now()
      },
    }
  }

  async warmup(): Promise<void> {
    const lease = await this.acquire()
    lease.release()
  }

  disposeIdle(): void {
    if (!this.managed) return
    if (this.managed.refCount > 0) return
    if (this.now() - this.managed.lastUsedAt < this.idleMs) return
    this.dispose()
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.managed) {
      this.managed.runtime.close()
      this.managed = null
    }
    this.starting = null
  }

  private async ensureRuntime(): Promise<ManagedRuntime> {
    if (this.managed) return this.managed
    if (this.starting) return this.starting
    this.starting = this.startRuntime().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startRuntime(): Promise<ManagedRuntime> {
    const sdk = await loadOpenCodeSdk(this.importSdk)
    const runtime = await sdk.createOpencodeServer({
      hostname: '127.0.0.1',
      port: 0,
      timeout: 10_000,
      config: { logLevel: 'ERROR' },
    })
    const managed: ManagedRuntime = {
      runtime,
      sdk,
      refCount: 0,
      lastUsedAt: this.now(),
    }
    this.managed = managed
    return managed
  }
}

export function __setOpenCodeSdkImporterForTest(fn: () => Promise<OpenCodeSdkModule>): void {
  sdkImporter = fn
  sdkPromise = null
}

export function __resetOpenCodeSdkImporterForTest(): void {
  sdkImporter = () => {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<OpenCodeSdkModule>
    return dynamicImport('@opencode-ai/sdk/v2')
  }
  sdkPromise = null
}

export const openCodeRuntimeManager = new OpenCodeRuntimeManager()
