// A TTS server that runs on this machine, such as a local OpenAI-compatible
// bridge. It is never started on its own: the settings page starts and stops
// it, and a class starts it on demand only when the learner turned that on.
// The child is spawned detached from DSH, so restarting DSH leaves a running
// server alone; stopping goes by the port owner, so a server started outside
// the plugin stops as well.

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const READY_TIMEOUT_MS = 25_000
const STOP_TIMEOUT_MS = 5_000
const POLL_MS = 250
const PROBE_TIMEOUT_MS = 1_500
const DEFAULT_PORT = 5050
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1']

export class LocalServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LocalServiceError'
    this.code = code
    // Shown to the learner as it is: every message names what to fix.
    this.userMessage = message
  }
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

// Whether a TTS address points at this machine, and which port it names.
export function localTarget(baseUrl) {
  let url
  try {
    url = new URL(String(baseUrl ?? ''))
  } catch {
    return { local: false, port: DEFAULT_PORT }
  }
  const local = LOOPBACK.includes(url.hostname.toLowerCase())
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  return { local, port }
}

function firstExisting(paths) {
  return paths.find(path => existsSync(path)) ?? null
}

// The interpreter and entry point of a service checkout: a .venv next to an
// app/server.py, which is what the common local TTS bridges ship.
function entryPoints(dir) {
  const windows = process.platform === 'win32'
  const python = firstExisting([
    join(dir, '.venv', windows ? 'Scripts' : 'bin', windows ? 'pythonw.exe' : 'python3'),
    join(dir, '.venv', windows ? 'Scripts' : 'bin', 'python.exe'),
    join(dir, '.venv', 'bin', 'python'),
  ])
  const script = firstExisting([join(dir, 'app', 'server.py'), join(dir, 'server.py')])
  if (!python) throw new LocalServiceError('no-python', 'The service folder has no virtual environment (.venv)')
  if (!script) throw new LocalServiceError('no-script', 'The service folder has no app/server.py')
  return { python, script }
}

export function createLocalService({ getPrefs, fetchImpl = globalThis.fetch, logger } = {}) {
  if (typeof getPrefs !== 'function') throw new TypeError('createLocalService needs getPrefs')
  let child = null
  let starting = null

  const prefs = () => getPrefs() ?? {}
  const root = () => String(prefs().localServiceRoot ?? '').trim()
  const target = () => localTarget(prefs().tts?.openai?.baseUrl)
  const probeUrl = port => `http://127.0.0.1:${port}/v1/models`

  // A server that answers at all is running; 401/403 only means it wants its key.
  async function reachable(port, timeoutMs = PROBE_TIMEOUT_MS) {
    if (!port) return false
    try {
      const response = await fetchImpl(probeUrl(port), { signal: AbortSignal.timeout(timeoutMs) })
      return response.ok || response.status === 401 || response.status === 403
    } catch {
      return false
    }
  }

  async function status() {
    const dir = root()
    const at = target()
    const running = at.local ? await reachable(at.port) : false
    return {
      root: dir,
      port: at.port,
      local: at.local,
      configured: Boolean(dir) && existsSync(dir),
      running,
      managed: running && Boolean(child && child.exitCode === null && !child.killed),
    }
  }

  async function start() {
    const before = await status()
    if (before.running) return before
    if (!before.root) throw new LocalServiceError('no-root', 'Set the local voice service folder first')
    if (!before.configured) throw new LocalServiceError('no-root', 'The local voice service folder does not exist')
    starting ??= (async () => {
      const { python, script } = entryPoints(before.root)
      const spawned = spawn(python, [script], {
        cwd: before.root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        // The bridge reads its port from the environment; no shell is involved.
        env: { ...process.env, PORT: String(before.port) },
      })
      spawned.unref()
      child = spawned
      spawned.on('exit', () => { if (child === spawned) child = null })
      logger?.debug?.('aha-tutor local voice: started pid %s on port %s', spawned.pid, before.port)
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (await reachable(before.port, 1_000)) return
        if (spawned.exitCode !== null) break
        await sleep(POLL_MS)
      }
      throw new LocalServiceError('not-ready', 'The local voice service started but did not answer')
    })().finally(() => { starting = null })
    await starting
    return status()
  }

  // The owner of the listening port, so a server this process did not spawn
  // can still be stopped.
  async function portOwner(port) {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'])
        for (const line of String(stdout).split(/\r?\n/u)) {
          const cells = line.trim().split(/\s+/u)
          if (cells.length < 5) continue
          const [, local, , state, pid] = cells
          if (state !== 'LISTENING' || !local.endsWith(`:${port}`)) continue
          const value = Number(pid)
          if (Number.isFinite(value) && value > 0) return value
        }
        return null
      }
      const { stdout } = await run('lsof', ['-ti', `tcp:${port}`])
      const value = Number(String(stdout).trim().split(/\s+/u)[0])
      return Number.isFinite(value) && value > 0 ? value : null
    } catch {
      return null
    }
  }

  async function stop() {
    const port = target().port
    const pid = await portOwner(port)
    if (!pid) return { ...(await status()), stopped: false }
    try {
      if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F'])
      else process.kill(pid, 'SIGTERM')
    } catch (error) {
      throw new LocalServiceError('stop-failed', `The local voice service did not stop: ${error?.message ?? error}`)
    }
    if (child?.pid === pid) child = null
    const deadline = Date.now() + STOP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!(await reachable(port, 800))) break
      await sleep(POLL_MS)
    }
    // The child handle is only useful while it is the server that is running.
    if (!(await reachable(port, 800))) child = null
    return { ...(await status()), stopped: true }
  }

  return Object.freeze({ status, start, stop })
}
