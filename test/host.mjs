/**
 * Zero-dependency self-check for the Host half.
 *
 * Mounts `lib/index.js` against a fake Cordis context (a capturing
 * `webServer.register`), points `DSH_HOME` at a temp directory, and drives the
 * four routes with Node-style request/response fakes:
 *
 *   GET  /dsh-enhancer/state
 *   POST /dsh-enhancer/mutate
 *   POST /dsh-enhancer/open-workspace
 *   GET  /dsh-enhancer/stream   (SSE)
 *
 * It verifies durable atomic writes, incremental mutations (two clients
 * hiding different workspaces), the SSE broadcast, the one-shot legacy flag,
 * reload from disk, corrupt-file tolerance, the upgrade migration from
 * `@adamcjm/dsh-workspace-visibility`, and every open-folder outcome (resolved
 * path, unknown workspace, deleted directory, failing opener).
 *
 * Opening a folder is injected through the fake context's
 * `openWorkspaceFolder` seam, so the suite never launches the real Finder.
 *
 * Run: node test/host.mjs
 */
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  (${detail})`}`)
}
function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)}`)
}

/** Node-style request fake carrying an optional JSON body. */
function makeReq(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  return req
}

/** Node-style response fake recording status/headers/body. */
function makeRes() {
  const handlers = new Map()
  const res = {
    statusCode: 200,
    headers: null,
    body: '',
    headersSent: false,
    ended: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
      res.headersSent = true
      return res
    },
    write(chunk) {
      res.body += String(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk)
      res.ended = true
      res.emit('close')
      return res
    },
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(listener)
      return res
    },
    emit(event) {
      for (const listener of handlers.get(event) ?? []) listener()
    },
  }
  return res
}

/** Read the last SSE data frame of a fake response. */
function lastFrame(res) {
  const frames = res.body.split('\n\n').filter((frame) => frame.startsWith('data: '))
  if (frames.length === 0) return null
  return JSON.parse(frames[frames.length - 1].slice('data: '.length))
}

/** Count SSE data frames recorded on a fake response. */
function countFrames(res) {
  return res.body.split('\n\n').filter((frame) => frame.startsWith('data: ')).length
}

/** Mount the plugin on a fake context; returns the captured route and disposers. */
function mount(options = {}) {
  const routes = []
  const effects = []
  const warnings = []
  const opened = []
  const registry = options.registry ?? null
  const baseCtx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    get(name) {
      return name === 'workspaceRegistry' ? registry : null
    },
    webServer: {
      register(route) {
        routes.push(route)
        let disposed = false
        return () => {
          disposed = true
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  if (options.injectOpener !== false) {
    baseCtx.openWorkspaceFolder = options.openWorkspaceFolder ?? (async (workspacePath) => { opened.push(workspacePath) })
  }
  /**
   * A real Cordis context is a proxy that throws when a plugin reads a service
   * it was not injected with; the proxy mirrors that so such a read fails here
   * instead of only in a live Host.
   */
  const ctx = new Proxy(baseCtx, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property)
      if (typeof property === 'symbol') return undefined
      throw new Error(`cannot get property "${String(property)}" without inject`)
    },
  })
  apply(ctx)
  const route = routes[0]
  return {
    ctx,
    route,
    warnings,
    opened,
    dispose() {
      for (const dispose of effects) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

async function call(route, method, path, body) {
  const req = makeReq(method, '/dsh-enhancer' + path, body)
  const res = makeRes()
  await route.handler(req, res)
  return res
}

const home = await mkdtemp(join(tmpdir(), 'enh-host-'))
process.env.DSH_HOME = home
const stateFile = join(home, 'storages', 'dsh-enhancer.json')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  const first = mount()
  check('registers one prefix route', first.route !== undefined
    && first.route.kind === 'prefix' && first.route.path === '/dsh-enhancer')

  const empty = await call(first.route, 'GET', '/state')
  equal('GET /state starts empty', {
    hidden: JSON.parse(empty.body).hidden,
    showHidden: JSON.parse(empty.body).showHidden,
    legacyCleanupDone: JSON.parse(empty.body).legacyCleanupDone,
  }, { hidden: [], showHidden: false, legacyCleanupDone: false })
  check('reading does not create the state file', await readFile(stateFile, 'utf8').then(() => false, () => true))

  const hiddenOne = JSON.parse((await call(first.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w1', value: true })).body)
  equal('mutate hides the workspace', hiddenOne.hidden, ['w1'])
  const disk = JSON.parse(await readFile(stateFile, 'utf8'))
  equal('state file persisted the hide', disk.hidden, ['w1'])
  equal('state file carries the schema version', disk.version, 1)

  const hiddenTwo = JSON.parse((await call(first.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w2', value: true })).body)
  equal('increments keep both client ids', hiddenTwo.hidden, ['w1', 'w2'])

  const stream = await call(first.route, 'GET', '/stream')
  equal('SSE responds with the baseline', lastFrame(stream).hidden, ['w1', 'w2'])
  check('SSE stays open', stream.ended === false && stream.headers['content-type'].startsWith('text/event-stream'))

  const shown = JSON.parse((await call(first.route, 'POST', '/mutate', { type: 'setShowHidden', value: true })).body)
  equal('switch mutation applied', shown.showHidden, true)
  equal('SSE broadcast the switch', lastFrame(stream).showHidden, true)

  const legacy = JSON.parse((await call(first.route, 'POST', '/mutate', { type: 'setLegacyCleanupDone', value: true })).body)
  equal('legacy cleanup flag applied', legacy.legacyCleanupDone, true)

  const bad = await call(first.route, 'POST', '/mutate', { type: 'nope' })
  check('unknown mutation answers 400', bad.statusCode === 400, String(bad.statusCode))
  const missing = await call(first.route, 'POST', '/mutate', { type: 'setHidden' })
  check('setHidden without id answers 400', missing.statusCode === 400, String(missing.statusCode))

  first.dispose()
  check('dispose ends the SSE response', stream.ended === true)

  // Reload from disk in a fresh instance (simulates a Host restart).
  const second = mount()
  const reloaded = JSON.parse((await call(second.route, 'GET', '/state')).body)
  equal('state reloaded from disk after restart', {
    hidden: reloaded.hidden, showHidden: reloaded.showHidden, legacyCleanupDone: reloaded.legacyCleanupDone,
  }, { hidden: ['w1', 'w2'], showHidden: true, legacyCleanupDone: true })
  second.dispose()

  // Corrupt file degrades to empty state with a warning, not a crash.
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(stateFile, '{ definitely not json', 'utf8')
  const third = mount()
  const recovered = JSON.parse((await call(third.route, 'GET', '/state')).body)
  equal('corrupt state file degrades to empty', recovered.hidden, [])
  check('corrupt state file logged a warning', third.warnings.some((message) => message.includes('无法读取')))
  third.dispose()
  await sleep(20)

  /* ------------------------------------------------------------------ *
   * Robustness scenarios                                                *
   * ------------------------------------------------------------------ */
  const caseDir = async (name) => {
    const dir = join(home, name)
    await mkdir(join(dir, 'storages'), { recursive: true })
    return dir
  }
  const stateAt = (dir) => join(dir, 'storages', 'dsh-enhancer.json')
  const knownRegistry = (ids) => ({
    get: (id) => (ids.includes(id) ? { id } : undefined),
  })

  // A. Stale ids (deleted workspaces) are pruned from the file on access.
  {
    const dir = await caseDir('case-a')
    await writeFile(stateAt(dir), JSON.stringify({
      version: 1, hidden: ['w1', 'ghost'], showHidden: false, legacyCleanupDone: true, updatedAt: null,
    }), 'utf8')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry(['w1']) })
    const state = JSON.parse((await call(instance.route, 'GET', '/state')).body)
    equal('stale hidden ids are pruned on access', state.hidden, ['w1'])
    equal('pruned hidden ids are persisted', JSON.parse(await readFile(stateAt(dir), 'utf8')).hidden, ['w1'])
    const rejected = JSON.parse((await call(instance.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'ghost', value: true })).body)
    check('hiding a deleted workspace is ignored', !rejected.hidden.includes('ghost'))
    const known = JSON.parse((await call(instance.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w1', value: false })).body)
    equal('a known workspace still mutates normally', known.hidden, [])
    check('prune logged the cleanup', instance.warnings.some((message) => message.includes('已不存在')))
    instance.dispose()
  }

  // B. An absurdly large state file is ignored, not parsed.
  {
    const dir = await caseDir('case-b')
    await writeFile(stateAt(dir), 'x'.repeat(1024 * 1024 + 32), 'utf8')
    process.env.DSH_HOME = dir
    const instance = mount()
    const state = JSON.parse((await call(instance.route, 'GET', '/state')).body)
    equal('oversized state file degrades to empty', state.hidden, [])
    check('oversized state file logged a warning', instance.warnings.some((message) => message.includes('过大')))
    instance.dispose()
  }

  // C. A missing registry is tolerated: no prune, no crash, state untouched.
  {
    const dir = await caseDir('case-c')
    await writeFile(stateAt(dir), JSON.stringify({
      version: 1, hidden: ['w1'], showHidden: false, legacyCleanupDone: true, updatedAt: null,
    }), 'utf8')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: null })
    const state = JSON.parse((await call(instance.route, 'GET', '/state')).body)
    equal('state is kept when the registry is unavailable', state.hidden, ['w1'])
    instance.dispose()
  }

  // D. A failed write keeps the in-memory state and never rejects the request.
  {
    const dir = await caseDir('case-d')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry(['w1']) })
    await chmod(join(dir, 'storages'), 0o500)
    try {
      const response = await call(instance.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w1', value: true })
      check('mutate succeeds even when the state file cannot be written', response.statusCode === 200)
      equal('in-memory state survives a failed write', JSON.parse(response.body).hidden, ['w1'])
      await sleep(30)
      check('failed write logged a warning', instance.warnings.some((message) => message.includes('写入状态失败')))
    } finally {
      await chmod(join(dir, 'storages'), 0o700)
      instance.dispose()
    }
  }

  /* ------------------------------------------------------------------ *
   * Cross-process sync (Desktop and `dsh web` are separate Hosts)       *
   * ------------------------------------------------------------------ */

  // E. A write from another Host process is picked up and broadcast.
  {
    const dir = await caseDir('case-e')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry(['w1', 'w2']) })
    await call(instance.route, 'GET', '/state')
    const stream = await call(instance.route, 'GET', '/stream')
    const framesBefore = countFrames(stream)
    await writeFile(stateAt(dir), JSON.stringify({
      version: 1, hidden: ['w2'], showHidden: true, legacyCleanupDone: true, updatedAt: new Date().toISOString(),
    }), 'utf8')
    await sleep(1300)
    const state = JSON.parse((await call(instance.route, 'GET', '/state')).body)
    equal('a write from another Host process is picked up', state.hidden, ['w2'])
    equal('the external change is broadcast to SSE clients', lastFrame(stream).hidden, ['w2'])
    check('the watcher adds no duplicate frames', countFrames(stream) === framesBefore + 1, `frames=${countFrames(stream)}`)
    instance.dispose()
  }

  // F. A mutation merges state written meanwhile by another Host process.
  {
    const dir = await caseDir('case-f')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry(['w1', 'w2', 'w3']) })
    await call(instance.route, 'GET', '/state')
    await writeFile(stateAt(dir), JSON.stringify({
      version: 1, hidden: ['w1', 'w2'], showHidden: false, legacyCleanupDone: true, updatedAt: new Date().toISOString(),
    }), 'utf8')
    const merged = JSON.parse((await call(instance.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w3', value: true })).body)
    equal("a mutation merges the other process's write", merged.hidden.slice().sort(), ['w1', 'w2', 'w3'])
    equal('the merged state is persisted', JSON.parse(await readFile(stateAt(dir), 'utf8')).hidden.slice().sort(), ['w1', 'w2', 'w3'])
    instance.dispose()
  }

  // G. Our own write is not broadcast twice by the watcher.
  {
    const dir = await caseDir('case-g')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry(['w1']) })
    await call(instance.route, 'GET', '/state')
    const stream = await call(instance.route, 'GET', '/stream')
    await call(instance.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w1', value: true })
    const afterMutation = countFrames(stream)
    await sleep(1300)
    check('own writes do not echo an extra frame', countFrames(stream) === afterMutation, `afterMutation=${afterMutation} afterPoll=${countFrames(stream)}`)
    instance.dispose()
  }

  // H. A corrupt external write keeps the in-memory state.
  {
    const dir = await caseDir('case-h')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry(['w1']) })
    await call(instance.route, 'GET', '/state')
    await call(instance.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w1', value: true })
    await writeFile(stateAt(dir), '{ broken json', 'utf8')
    await sleep(1300)
    const state = JSON.parse((await call(instance.route, 'GET', '/state')).body)
    equal('a corrupt external write keeps the in-memory state', state.hidden, ['w1'])
    instance.dispose()
  }

  // I. Two Host processes mutating concurrently: both changes survive.
  {
    const dir = await caseDir('case-i')
    process.env.DSH_HOME = dir
    const first = mount({ registry: knownRegistry(['w1', 'w2']) })
    const second = mount({ registry: knownRegistry(['w1', 'w2']) })
    await call(first.route, 'GET', '/state')
    await call(second.route, 'GET', '/state')
    await Promise.all([
      call(first.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w1', value: true }),
      call(second.route, 'POST', '/mutate', { type: 'setHidden', workspaceId: 'w2', value: true }),
    ])
    const disk = JSON.parse(await readFile(stateAt(dir), 'utf8'))
    equal('concurrent mutations from two Hosts both survive', disk.hidden.slice().sort(), ['w1', 'w2'])
    first.dispose()
    second.dispose()
  }

  /* ------------------------------------------------------------------ *
   * Open folder: the Host resolves the directory from the registry      *
   * ------------------------------------------------------------------ */
  // J. Only a workspace id crosses the wire; the path comes from the registry.
  {
    const dir = await caseDir('case-j')
    process.env.DSH_HOME = dir
    const openRegistry = {
      get: (id) => (id === 'w-open'
        ? { id, path: '/Users/adam/projects/demo', status: async () => 'ok' }
        : undefined),
    }
    const instance = mount({ registry: openRegistry })
    const response = await call(instance.route, 'POST', '/open-workspace', { workspaceId: 'w-open' })
    check('open answers 200', response.statusCode === 200, String(response.statusCode))
    equal('open returns the registry path', JSON.parse(response.body).path, '/Users/adam/projects/demo')
    equal('the opener received the registry path', instance.opened, ['/Users/adam/projects/demo'])

    const noId = await call(instance.route, 'POST', '/open-workspace', {})
    check('open without an id answers 400', noId.statusCode === 400, String(noId.statusCode))
    const unknown = await call(instance.route, 'POST', '/open-workspace', { workspaceId: 'ghost' })
    check('open for an unknown workspace answers 404', unknown.statusCode === 404, String(unknown.statusCode))
    equal('nothing was opened for unknown ids', instance.opened, ['/Users/adam/projects/demo'])
    instance.dispose()
  }

  // K. A deleted directory is refused instead of spawning a raw OS dialog.
  {
    const dir = await caseDir('case-k')
    process.env.DSH_HOME = dir
    const goneRegistry = {
      get: (id) => (id === 'w-gone'
        ? { id, path: '/Users/adam/projects/gone', status: async () => 'missing-dir' }
        : undefined),
    }
    const instance = mount({ registry: goneRegistry })
    const response = await call(instance.route, 'POST', '/open-workspace', { workspaceId: 'w-gone' })
    check('a missing directory answers 409', response.statusCode === 409, String(response.statusCode))
    equal('a missing directory reports missing-dir', JSON.parse(response.body).error, 'missing-dir')
    equal('nothing is opened for a missing directory', instance.opened, [])
    instance.dispose()
  }

  // L. A failing opener becomes a JSON error, not a thrown route.
  {
    const dir = await caseDir('case-l')
    process.env.DSH_HOME = dir
    const failingRegistry = {
      get: (id) => (id === 'w-open' ? { id, path: '/tmp/x', status: async () => 'ok' } : undefined),
    }
    const instance = mount({
      registry: failingRegistry,
      openWorkspaceFolder: async () => { throw new Error('spawn ENOENT') },
    })
    const response = await call(instance.route, 'POST', '/open-workspace', { workspaceId: 'w-open' })
    check('a failing opener answers 500', response.statusCode === 500, String(response.statusCode))
    equal('a failing opener reports open-failed', JSON.parse(response.body).error, 'open-failed')
    check('a failing opener logged a warning', instance.warnings.some((message) => message.includes('无法打开')))
    instance.dispose()
  }

  /* ------------------------------------------------------------------ *
   * Upgrade from @adamcjm/dsh-workspace-visibility                     *
   * ------------------------------------------------------------------ */
  // M. A context that never injected the opener still mounts. Cordis proxies
  //    throw on a property read the plugin did not inject, so the fallback must
  //    be guarded instead of crashing the whole plugin.
  {
    const dir = await caseDir('case-no-opener')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry([]), injectOpener: false })
    check('mounting without an injected opener falls back instead of throwing',
      instance.route !== undefined && instance.route.path === '/dsh-enhancer')
    instance.dispose()
  }

  // N. The previous package's state file is adopted exactly once.
  {
    const dir = await caseDir('case-m')
    await writeFile(join(dir, 'storages', 'workspace-visibility.json'), JSON.stringify({
      version: 1, hidden: ['old-1', 'old-2'], showHidden: true, legacyCleanupDone: true, updatedAt: null,
    }), 'utf8')
    process.env.DSH_HOME = dir
    const instance = mount({ registry: knownRegistry(['old-1', 'old-2']) })
    const adopted = JSON.parse((await call(instance.route, 'GET', '/state')).body)
    equal('the previous state file is adopted', adopted.hidden, ['old-1', 'old-2'])
    equal('the previous switch is adopted', adopted.showHidden, true)
    equal('the adopted state is written under the new name',
      JSON.parse(await readFile(stateAt(dir), 'utf8')).hidden, ['old-1', 'old-2'])
    check('the adoption is logged', instance.warnings.some((message) => message.includes('旧状态文件')))
    instance.dispose()
  }
} finally {
  await rm(home, { recursive: true, force: true })
}

const failed = checks.filter((item) => !item.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.error('\nFailures:')
  for (const item of failed) console.error(` - ${item.name}${item.detail === undefined ? '' : ` (${item.detail})`}`)
  process.exit(1)
}
