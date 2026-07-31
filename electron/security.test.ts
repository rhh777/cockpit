import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { isAllowedExternalUrl, isSameAppOrigin, resolveStaticAsset } from './security'

test('resolveStaticAsset keeps requests inside dist', () => {
  const dist = path.resolve('/app/dist')
  assert.equal(resolveStaticAsset(dist, '/assets/app.js'), path.join(dist, 'assets/app.js'))
  assert.equal(resolveStaticAsset(dist, '/'), path.join(dist, 'index.html'))
  // URL parsing normalizes a plain `..` before filesystem resolution, leaving a safe in-dist path.
  assert.equal(resolveStaticAsset(dist, '/../dist-electron/main.cjs'), path.join(dist, 'dist-electron/main.cjs'))
  // Encoded slash survives URL normalization, then decodeURIComponent exposes the traversal attempt.
  assert.equal(resolveStaticAsset(dist, '/%2e%2e%2fdist-electron/main.cjs'), null)
})

test('external URLs and app navigation use explicit allowlists', () => {
  assert.equal(isAllowedExternalUrl('https://example.com'), true)
  assert.equal(isAllowedExternalUrl('codex://threads/abc'), true)
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
  assert.equal(isSameAppOrigin('http://127.0.0.1:43127/cockpit/x', 'http://127.0.0.1:43127'), true)
  assert.equal(isSameAppOrigin('https://example.com', 'http://127.0.0.1:43127'), false)
})
