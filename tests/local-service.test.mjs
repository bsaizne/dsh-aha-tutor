import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { LocalServiceError, createLocalService, localTarget } from '../src/host/local-service.js'

const prefsWith = value => () => value

test('localTarget tells this machine from another', () => {
  assert.deepEqual(localTarget('http://127.0.0.1:5050/v1'), { local: true, port: 5050 })
  assert.deepEqual(localTarget('http://localhost:9000/v1'), { local: true, port: 9000 })
  assert.deepEqual(localTarget('http://[::1]:5050/v1'), { local: true, port: 5050 })
  assert.deepEqual(localTarget('https://api.openai.com/v1'), { local: false, port: 443 })
  assert.deepEqual(localTarget(''), { local: false, port: 5050 })
})

test('status reports an unconfigured service without starting anything', async () => {
  const service = createLocalService({ getPrefs: prefsWith({ tts: { openai: { baseUrl: 'http://127.0.0.1:5050/v1' } } }), fetchImpl: async () => { throw new Error('offline') } })
  const status = await service.status()
  assert.equal(status.running, false)
  assert.equal(status.configured, false)
  assert.equal(status.port, 5050)
  assert.equal(status.managed, false)
})

test('start refuses a folder that is not set, and one that has no entry point', async () => {
  const unset = createLocalService({ getPrefs: prefsWith({}) })
  await assert.rejects(() => unset.start(), error => error instanceof LocalServiceError && error.code === 'no-root')

  const dir = await mkdtemp(join(tmpdir(), 'aha-local-service-'))
  try {
    const empty = createLocalService({ getPrefs: prefsWith({ localServiceRoot: dir }) })
    await assert.rejects(() => empty.start(), error => error instanceof LocalServiceError && (error.code === 'no-python' || error.code === 'no-script'))

    // A checkout with a script but no virtual environment names the missing part.
    await mkdir(join(dir, 'app'), { recursive: true })
    await writeFile(join(dir, 'app', 'server.py'), 'print("hi")\n')
    const noVenv = createLocalService({ getPrefs: prefsWith({ localServiceRoot: dir }) })
    await assert.rejects(() => noVenv.start(), error => error.code === 'no-python')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stop reports nothing stopped when no server listens', async () => {
  const service = createLocalService({ getPrefs: prefsWith({ tts: { openai: { baseUrl: 'http://127.0.0.1:9/v1' } } }), fetchImpl: async () => { throw new Error('offline') } })
  const result = await service.stop()
  assert.equal(result.stopped, false)
  assert.equal(result.running, false)
})
