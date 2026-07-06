import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexAppServer, type CodexApprovalResponse, type JsonRpcNotification, type JsonRpcRequest } from './codex-app-server'
import { CodexRuntimeManager, type CodexRuntimeServer } from './codex-runtime-manager'

class FakeCodexRuntimeServer implements CodexRuntimeServer {
  onNotification: ((n: JsonRpcNotification) => void) | null = null
  onServerRequest: ((r: JsonRpcRequest) => void) | null = null
  spawnCalls = 0
  killCalls = 0
  notifyCalls: Array<{ method: string; params?: unknown }> = []
  requests: Array<{ method: string; params: unknown }> = []

  async spawn(): Promise<void> {
    this.spawnCalls += 1
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params })
    return {} as T
  }

  notify(method: string, params?: unknown): void {
    this.notifyCalls.push({ method, params })
  }

  respond(_id: string | number, _response: CodexApprovalResponse): void {
    // Tests below do not exercise server-initiated requests.
  }

  readLoop(): Promise<void> {
    return new Promise(() => {})
  }

  kill(): void {
    this.killCalls += 1
  }
}

function createTestManager(server: FakeCodexRuntimeServer, now: () => number) {
  return new CodexRuntimeManager({
    autoSweep: false,
    idleMs: 100,
    createServer: () => server,
    resolveCommand: async () => '/tmp/fake-codex',
    now,
  })
}

test('CodexRuntimeManager reuses one app-server process for repeated acquires', async () => {
  let now = 0
  const server = new FakeCodexRuntimeServer()
  const manager = createTestManager(server, () => now)
  const signal = new AbortController().signal

  const lease1 = await manager.acquire(signal)
  lease1.release()
  now += 10
  const lease2 = await manager.acquire(signal)
  lease2.release()

  assert.equal(server.spawnCalls, 1)
  assert.equal(server.requests.filter((r) => r.method === 'initialize').length, 1)
  assert.equal(server.notifyCalls.filter((n) => n.method === 'initialized').length, 1)
  await manager.disposeAll()
})

test('CodexRuntimeManager does not idle-dispose an active lease', async () => {
  let now = 0
  const server = new FakeCodexRuntimeServer()
  const manager = createTestManager(server, () => now)
  const lease = await manager.acquire(new AbortController().signal)

  await manager.disposeIdle(1000)
  assert.equal(server.killCalls, 0)
  assert.equal(manager.getSessionSnapshot()[0]?.refCount, 1)

  lease.release()
  now = 1000
  await manager.disposeIdle(1000)
  assert.equal(server.killCalls, 1)
  await manager.disposeAll()
})

test('CodexRuntimeManager serializes active turns on the shared process', async () => {
  const server = new FakeCodexRuntimeServer()
  const manager = createTestManager(server, () => 0)
  const signal = new AbortController().signal
  const lease1 = await manager.acquire(signal)

  let secondAcquired = false
  const secondAcquire = manager.acquire(signal).then((lease) => {
    secondAcquired = true
    return lease
  })
  await Promise.resolve()
  assert.equal(secondAcquired, false)

  lease1.release()
  const lease2 = await secondAcquire
  assert.equal(secondAcquired, true)
  lease2.release()
  await manager.disposeAll()
})

test('CodexRuntimeManager removes aborted waiters from refcount', async () => {
  const server = new FakeCodexRuntimeServer()
  const manager = createTestManager(server, () => 0)
  const lease1 = await manager.acquire(new AbortController().signal)

  const waitingController = new AbortController()
  const waiting = manager.acquire(waitingController.signal)
  waitingController.abort()
  await assert.rejects(waiting, /aborted/)

  assert.equal(manager.getSessionSnapshot()[0]?.refCount, 1)
  lease1.release()
  assert.equal(manager.getSessionSnapshot()[0]?.refCount, 0)
  await manager.disposeAll()
})

test('CodexAppServer keeps stderr bounded for long-lived processes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-app-server-'))
  const bin = path.join(dir, 'fake-codex.js')
  const stderr = '0123456789abcdefghijklmnopqrstuvwxyz'
  await writeFile(
    bin,
    `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(stderr)});\nsetTimeout(() => process.exit(0), 10);\n`,
  )
  await chmod(bin, 0o755)

  try {
    const server = new CodexAppServer({ stderrLimit: 8 })
    await server.spawn(bin)
    await server.readLoop()
    assert.equal(server.stderrText, stderr.slice(-8))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
