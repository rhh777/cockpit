import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLocalApiRequest } from './local-request'

test('accepts same-origin browser mutations on loopback', () => {
  assert.equal(checkLocalApiRequest({
    method: 'POST',
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
    fetchSite: 'same-origin',
  }).ok, true)
})

test('accepts local CLI requests without browser origin headers', () => {
  assert.equal(checkLocalApiRequest({ method: 'POST', host: '127.0.0.1:43127' }).ok, true)
})

test('rejects cross-site browser requests even when targeting loopback', () => {
  assert.deepEqual(checkLocalApiRequest({
    method: 'POST',
    host: 'localhost:5173',
    origin: 'https://attacker.example',
    fetchSite: 'cross-site',
  }), { ok: false, status: 403, reason: 'cross-site-request' })
})

test('rejects a different loopback origin and non-loopback Host', () => {
  assert.equal(checkLocalApiRequest({
    method: 'POST',
    host: 'localhost:5173',
    origin: 'http://127.0.0.1:5173',
  }).reason, 'origin-mismatch')
  assert.equal(checkLocalApiRequest({ method: 'GET', host: '192.168.1.20:5173' }).reason, 'non-loopback-host')
})
