/**
 * Host half of `@adamcjm/dsh-enhancer`.
 *
 * Owns the durable visibility state, the "open this workspace's folder"
 * action, and the HTTP surface the browser half talks to:
 *
 *   GET  /dsh-enhancer/state          → the current state
 *   POST /dsh-enhancer/mutate         → one incremental mutation
 *   POST /dsh-enhancer/open-workspace → open one workspace directory on the
 *                                       user's desktop with the system file
 *                                       manager
 *   GET  /dsh-enhancer/stream         → SSE stream, one state per change
 *
 * State file: `$DSH_HOME/storages/dsh-enhancer.json`, written
 * atomically (temp file + rename) from a serialized queue. The Host is the
 * only authority: browsers never persist the state themselves (same model as
 * the shipped workspace registry, whose order lives in
 * `$DSH_HOME/storages/workspace.json`).
 *
 * On first start the previous package's `workspace-visibility.json` is adopted
 * once, so upgrading from `@adamcjm/dsh-workspace-visibility` keeps every
 * hidden workspace. The old file is left in place for a manual rollback.
 *
 * Multi-client sync is push-based: every connected client holds one SSE
 * connection and receives the complete new state after any mutation, so a
 * change made in Desktop reaches an open Web page (and other tabs/browsers)
 * without a refresh — mirroring the shipped `workspace/follow` stream.
 *
 * @module @adamcjm/dsh-enhancer
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-enhancer'

/** One optional HTTP carrier; the browser half needs the routes below. */
export const inject = ['webServer']

/** Route prefix owned by this package. */
const PREFIX = '/dsh-enhancer'
/** Durable state schema version. */
const STATE_VERSION = 1
/** Guard rails for a hostile or corrupted payload. */
const MAX_BODY_BYTES = 64 * 1024
const MAX_HIDDEN = 2000
/** Ignore an absurdly large state file instead of parsing it into memory. */
const MAX_STATE_FILE_BYTES = 1024 * 1024
/** How often stale ids (workspaces deleted while no browser was open) are pruned. */
const PRUNE_INTERVAL_MS = 60_000
/**
 * How often the state file is stat'ed for changes written by ANOTHER Host
 * process. DSH Desktop and `dsh web` run separate Host processes but share
 * `$DSH_HOME`; without this watch their in-memory states drift apart.
 */
const POLL_INTERVAL_MS = 800
/** A lock file older than this is considered abandoned (crashed writer). */
const LOCK_STALE_MS = 10_000
/** How long a mutation waits for the cross-process write lock. */
const LOCK_WAIT_MS = 1500
/** SSE keep-alive cadence (comment frames keep idle sockets alive). */
const STREAM_PING_MS = 25_000
/** Trash layout under `$DSH_HOME`: `trash/sessions/<stamp>_<sessionId>/`. */
const TRASH_DIR = 'trash'
const TRASH_SESSIONS_DIR = 'sessions'
const TRASH_MANIFEST = 'manifest.json'
const TRASH_DATA = 'data'
/** One trash listing never materializes more than this many entries. */
const MAX_TRASH_ENTRIES = 1000
/** A quiet guard against a runaway directory walk when sizing one session. */
const MAX_SIZE_ENTRIES = 20_000

/**
 * Hot-reload helper shared across module instances: the web server rejects a
 * duplicate (kind, path) route, so a freshly applied instance first releases
 * whatever the previous instance still holds.
 */
const ROUTES_HOLDER = (() => {
  const key = Symbol.for('@adamcjm/dsh-enhancer/route-disposers')
  if (globalThis[key] === undefined) globalThis[key] = { value: undefined }
  return globalThis[key]
})()

function disposeRoutes() {
  const dispose = ROUTES_HOLDER.value
  if (typeof dispose !== 'function') return
  ROUTES_HOLDER.value = undefined
  try { dispose() } catch { /* the previous instance is already gone */ }
}

/** DSH home directory (`DSH_HOME`, else the platform default `~/.dsh`). */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** Durable state file location. */
function statePath() {
  return join(resolveDshHome(), 'storages', 'dsh-enhancer.json')
}

/**
 * State file of the package this one replaces. It stored the exact same schema
 * (`hidden`, `showHidden`, `legacyCleanupDone`), so the first load that finds
 * no new file adopts it once. The literal name is intentional: it must keep
 * pointing at the old file forever, not follow this package's own name.
 */
function legacyStatePath() {
  return join(resolveDshHome(), 'storages', 'workspace-visibility.json')
}

/**
 * Open one directory with the platform's own file manager.
 *
 * Only the Host process can reach the user's desktop, so the browser sends a
 * workspace id and the Host decides what to run: Finder on macOS (`open`),
 * Explorer on Windows, xdg-open on Linux. The child is started detached and
 * unref'd, so the HTTP request resolves as soon as the launcher exists instead
 * of waiting for the file manager to exit.
 */
function openWithSystem(workspacePath) {
  const command = process.platform === 'darwin'
    ? '/usr/bin/open'
    : process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'linux'
        ? 'xdg-open'
        : null
  if (command === null) {
    const error = new Error(`unsupported platform: ${process.platform}`)
    error.code = 'unsupported-platform'
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let child
    try {
      child = spawn(command, [workspacePath], { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      try { child.unref() } catch { /* child is already gone */ }
      resolve()
    })
  })
}

/* ------------------------------------------------------------------ *
 * Session trash: filesystem layout                                    *
 *                                                                     *
 * Deliberately independent of the DSH session path encoding: a session*
 * is located by matching the `<sessionId>` entry name inside any       *
 * `$DSH_HOME/sessions/<group>/` directory, so an encoding change or a  *
 * switch between the directory and single-file shapes never turns a    *
 * delete into a wrong-file delete. Anything unexpected is reported and *
 * nothing is moved.                                                    *
 * ------------------------------------------------------------------ */

/** `$DSH_HOME/sessions`, the root DSH itself reads. */
function sessionsRoot() {
  return join(resolveDshHome(), 'sessions')
}

/** `$DSH_HOME/trash/sessions`, owned by this plugin; DSH never scans it. */
function trashSessionsRoot() {
  return join(resolveDshHome(), TRASH_DIR, TRASH_SESSIONS_DIR)
}

/** Sortable, filesystem-safe stamp (`2026-10-23T07-34-00-000Z`). */
function trashStamp(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Find where DSH physically stores one session, without decoding the cwd
 * directory name. Returns `{ absolute, shape, originalPath }` where
 * `originalPath` is the path relative to `sessions/`, or `null` when the
 * session has no recognizable physical form.
 */
async function locateSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '' || /[/\\]/.test(sessionId)) return null
  const root = sessionsRoot()
  let groups
  try {
    groups = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return null
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = join(root, group.name)
    let entries
    try {
      entries = await readdir(groupDir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    const exact = entries.find((entry) => entry.name === sessionId)
    if (exact !== undefined) {
      return {
        absolute: join(groupDir, exact.name),
        shape: exact.isDirectory() ? 'directory' : 'file',
        originalPath: join(group.name, exact.name) + (exact.isDirectory() ? '/' : ''),
      }
    }
    // Tolerate a future single-file layout: `<id>.jsonl*` next to the id.
    const shaped = entries.find((entry) => entry.name.startsWith(`${sessionId}.`))
    if (shaped !== undefined) {
      return {
        absolute: join(groupDir, shaped.name),
        shape: 'file',
        originalPath: join(group.name, shaped.name),
      }
    }
  }
  return null
}

/** Total bytes of one file or directory tree, bounded. */
async function measurePath(target, budget = { left: MAX_SIZE_ENTRIES }) {
  try {
    const info = await stat(target)
    if (info.isFile()) return info.size
    if (!info.isDirectory()) return 0
    let total = 0
    const entries = await readdir(target, { withFileTypes: true })
    for (const entry of entries) {
      if (budget.left <= 0) break
      budget.left -= 1
      total += await measurePath(join(target, entry.name), budget)
    }
    return total
  } catch (error) {
    return 0
  }
}

/** Read one trash entry manifest, or `undefined` when it is not a valid entry. */
async function readManifest(entryDir) {
  try {
    const raw = await readFile(join(entryDir, TRASH_MANIFEST), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    if (typeof parsed.entryId !== 'string' || typeof parsed.sessionId !== 'string') return undefined
    return parsed
  } catch (error) {
    return undefined
  }
}

/** Write one trash entry manifest atomically (temp file + rename). */
async function writeManifest(entryDir, manifest) {
  const target = join(entryDir, TRASH_MANIFEST)
  const temp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, target)
}

/** Default state used before the file exists (or after a corrupt read). */
function emptyState() {
  return {
    version: STATE_VERSION,
    hidden: [],
    showHidden: false,
    legacyCleanupDone: false,
    updatedAt: null,
  }
}

function uniqueIds(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_HIDDEN) break
  }
  return out
}

/** Validate a state read from disk or built by a mutation. */
function normalizeState(input) {
  const base = emptyState()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return base
  return {
    version: STATE_VERSION,
    hidden: uniqueIds(input.hidden),
    showHidden: input.showHidden === true,
    legacyCleanupDone: input.legacyCleanupDone === true,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  }
}

/** Write a JSON response on the Node HTTP response object. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read and validate a JSON request body with a hard size cap. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/**
 * Cordis plugin entry: load the durable state lazily, then serve the routes.
 * Mutations are serialized through one write chain and broadcast to every SSE
 * subscriber; opening a folder is a side-effect-free spawn and never touches
 * the state file.
 */
export function apply(ctx) {
  const file = statePath()
  /**
   * Opening a folder is the only Host side effect besides the state file. The
   * opener is injectable so tests can assert the resolved path without actually
   * launching the user's file manager.
   *
   * The read is wrapped in try/catch: a Cordis context is a proxy that THROWS on
   * a property it was not injected with, so a plain `ctx?.openWorkspaceFolder`
   * would fail the whole plugin on a context that never declares it.
   */
  let openFolder = openWithSystem
  try {
    const override = ctx?.openWorkspaceFolder
    if (typeof override === 'function') openFolder = override
  } catch { /* not injected: keep the platform launcher */ }
  let state = null
  let loading = null
  let writeChain = Promise.resolve()
  /** Last file version observed by this process (for cross-process polling). */
  let lastSeenMtimeMs = 0
  let lastSeenSize = -1
  /** Live SSE responses. */
  const streams = new Set()

  function loggerWarn(message) {
    try { ctx.logger?.warn?.(message) } catch { /* logging must never break the plugin */ }
  }

  /**
   * Adopt the previous package's state file exactly once, so upgrading does not
   * resurrect every hidden workspace. The adopted state is written under this
   * package's name; the old file stays untouched so a rollback still works.
   */
  async function adoptLegacyFile() {
    try {
      const info = await stat(legacyStatePath())
      if (info.size > MAX_STATE_FILE_BYTES) return emptyState()
      const raw = await readFile(legacyStatePath(), 'utf8')
      const adopted = normalizeState(JSON.parse(raw))
      loggerWarn(`dsh-enhancer: 已从旧状态文件迁移 ${adopted.hidden.length} 个隐藏工作区 / adopted ${adopted.hidden.length} hidden workspaces from the previous package`)
      state = adopted
      await persist()
      return adopted
    } catch (error) {
      return emptyState()
    }
  }

  function loadState() {
    // Once loaded, always answer with the CURRENT in-memory state: mutations
    // replace `state`, so the cached loading promise alone would go stale.
    if (state !== null) return Promise.resolve(state)
    if (loading !== null) return loading
    loading = (async () => {
      try {
        const info = await stat(file)
        lastSeenMtimeMs = info.mtimeMs
        lastSeenSize = info.size
        if (info.size > MAX_STATE_FILE_BYTES) {
          loggerWarn('dsh-enhancer: 状态文件异常过大，已忽略并使用空状态')
          state = emptyState()
          return state
        }
        const raw = await readFile(file, 'utf8')
        state = normalizeState(JSON.parse(raw))
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          loggerWarn(`dsh-enhancer: 状态文件无法读取，使用空状态 (${String(error?.message || error)})`)
          state = emptyState()
          return state
        }
        // No file under this package's name yet: inherit the previous one.
        state = await adoptLegacyFile()
      }
      return state
    })()
    return loading
  }

  /** Optional registry lookup: never a hard dependency, never throws. */
  function registry() {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
      return service !== null && service !== undefined && typeof service.get === 'function' ? service : null
    } catch (error) {
      return null
    }
  }

  /* ------------------------------------------------------------------ *
   * Session trash: Host operations                                      *
   * ------------------------------------------------------------------ */

  /** Optional session persistence lookup (existence, list, header). */
  function sessionStore() {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : null
      return service !== null && service !== undefined && typeof service.list === 'function' ? service : null
    } catch (error) {
      return null
    }
  }

  /** Optional session controller (the only reliable `running` signal). */
  function sessionControllerService() {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionController') : null
      return service !== null && service !== undefined && typeof service.list === 'function' ? service : null
    } catch (error) {
      return null
    }
  }

  /** Optional live-agent registry, the fallback busy check. */
  function agentRegistry() {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('agents') : null
      return service !== null && service !== undefined && typeof service.get === 'function' ? service : null
    } catch (error) {
      return null
    }
  }

  /**
   * The session controller's summary rows, or `null` when the service is not
   * available. `running` and `parentSessionId` come from here; the projection
   * cache inside each row also carries the durable title.
   */
  async function sessionSummaries() {
    const controller = sessionControllerService()
    if (controller === null) return null
    try {
      const result = await controller.list({}, new AbortController().signal)
      return result !== null && result !== undefined && Array.isArray(result.items) ? result.items : null
    } catch (error) {
      loggerWarn(`dsh-enhancer: 无法读取会话列表 (${String(error?.message || error)})`)
      return null
    }
  }

  /** Durable title carried by a controller summary, when present. */
  function titleFromSummary(summary) {
    if (summary === null || summary === undefined) return ''
    const projections = summary.projections
    const values = (projections !== null && typeof projections === 'object') ? projections.values : null
    const title = (values !== null && typeof values === 'object') ? values.title : undefined
    return typeof title === 'string' ? title : ''
  }

  /** Which workspace currently accounts for one session, if any. */
  function workspaceFor(sessionId) {
    const reg = registry()
    if (reg === null || typeof reg.list !== 'function') return null
    try {
      for (const workspace of reg.list()) {
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return workspace
      }
    } catch (error) { /* registry hiccup: treat as unowned */ }
    return null
  }

  /** Preflight for one delete: existence, activity, title, owner, children. */
  async function inspectSession(sessionId, summaries) {
    const rows = summaries === undefined ? await sessionSummaries() : summaries
    const summary = rows === null ? null : rows.find((item) => item.sessionId === sessionId) ?? null
    const located = await locateSession(sessionId)
    let running = summary !== null && summary.running === true
    if (!running) {
      const agents = agentRegistry()
      if (agents !== null) {
        try { running = agents.get(sessionId) !== undefined } catch (error) { /* keep the summary answer */ }
      }
    }
    const children = rows === null
      ? []
      : rows
        .filter((item) => item.parentSessionId === sessionId)
        .map((item) => ({ sessionId: item.sessionId, title: titleFromSummary(item) }))
    const workspace = workspaceFor(sessionId)
    const store = sessionStore()
    let cwd = typeof summary?.cwd === 'string' ? summary.cwd : ''
    if (cwd === '' && store !== null) {
      try {
        const snapshot = await store.stat(sessionId)
        if (typeof snapshot?.header?.cwd === 'string') cwd = snapshot.header.cwd
      } catch (error) { /* absent is fine */ }
    }
    return {
      exists: located !== null || summary !== null,
      located: located !== null,
      running,
      title: titleFromSummary(summary),
      cwd,
      workspaceId: workspace !== null ? workspace.id : null,
      workspaceTitle: workspace !== null ? workspace.title : '',
      children,
    }
  }

  /**
   * Drop every durable reference the workspace registry holds for a session.
   * Runs before the filesystem move: `detachSession` is what makes the sidebar
   * re-read its groups, so the row disappears without pointing at nothing.
   */
  async function forgetSession(sessionId) {
    const reg = registry()
    if (reg === null) return
    const workspace = workspaceFor(sessionId)
    if (workspace !== null && typeof workspace.detachSession === 'function') {
      try { await workspace.detachSession(sessionId) } catch (error) {
        loggerWarn(`dsh-enhancer: 解除工作区归属失败 ${sessionId} (${String(error?.message || error)})`)
      }
    }
    if (typeof reg.unarchiveSession === 'function') {
      try { await reg.unarchiveSession(sessionId) } catch (error) {
        loggerWarn(`dsh-enhancer: 取消归档失败 ${sessionId} (${String(error?.message || error)})`)
      }
    }
    if (typeof reg.unpinSession === 'function') {
      try { await reg.unpinSession(sessionId) } catch (error) {
        loggerWarn(`dsh-enhancer: 取消置顶失败 ${sessionId} (${String(error?.message || error)})`)
      }
    }
  }

  /** Move one located session into the trash; returns its manifest. */
  async function trashOne(sessionId, info, extra) {
    const located = await locateSession(sessionId)
    if (located === null) {
      const error = new Error('session-file-not-found')
      error.code = 'session-file-not-found'
      throw error
    }
    const entryId = `${trashStamp(new Date())}_${sessionId}`
    const entryDir = join(trashSessionsRoot(), entryId)
    const dataDir = join(entryDir, TRASH_DATA)
    await mkdir(entryDir, { recursive: true })
    try {
      await rename(located.absolute, dataDir)
    } catch (error) {
      await rm(entryDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    const manifest = {
      entryId,
      sessionId,
      title: extra.title !== undefined && extra.title !== '' ? extra.title : info.title,
      workspaceId: info.workspaceId,
      workspaceTitle: info.workspaceTitle,
      cwd: info.cwd,
      shape: located.shape,
      originalPath: located.originalPath,
      deletedAt: new Date().toISOString(),
      sizeBytes: await measurePath(dataDir),
      children: extra.children ?? [],
      orphanedChildren: extra.orphanedChildren ?? [],
    }
    await writeManifest(entryDir, manifest)
    return manifest
  }

  /**
   * Move one session (and optionally its child sessions) into the trash.
   *
   * Children move first so the parent manifest can record their entry ids;
   * restoring the parent then restores its still-present children with it.
   * Without `includeChildren` the children stay in place as orphans.
   */
  async function moveSessionToTrash(sessionId, includeChildren, clientTitle) {
    const summaries = await sessionSummaries()
    const info = await inspectSession(sessionId, summaries)
    if (!info.exists) {
      const error = new Error('session-not-found')
      error.code = 'session-not-found'
      throw error
    }
    if (info.running) {
      const error = new Error('session-running')
      error.code = 'session-running'
      throw error
    }
    if (!info.located) {
      const error = new Error('session-file-not-found')
      error.code = 'session-file-not-found'
      throw error
    }
    const childEntries = []
    if (includeChildren === true) {
      for (const child of info.children) {
        const childInfo = await inspectSession(child.sessionId, summaries)
        if (childInfo.running) {
          const error = new Error('child-running')
          error.code = 'child-running'
          error.detail = { sessionId: child.sessionId, title: child.title }
          throw error
        }
        if (!childInfo.located) continue
        await forgetSession(child.sessionId)
        const childManifest = await trashOne(child.sessionId, { ...childInfo, title: child.title || childInfo.title }, {})
        childEntries.push({
          entryId: childManifest.entryId,
          sessionId: childManifest.sessionId,
          title: childManifest.title,
          parentEntryId: null,
        })
      }
    }
    await forgetSession(sessionId)
    const parent = await trashOne(sessionId, info, {
      title: typeof clientTitle === 'string' ? clientTitle.trim() : '',
      children: childEntries,
      orphanedChildren: includeChildren === true ? [] : info.children,
    })
    // Back-fill the parent entry id so a child knows which deletion it belongs to.
    for (const childEntry of childEntries) {
      try {
        const childDir = join(trashSessionsRoot(), childEntry.entryId)
        const childManifest = await readManifest(childDir)
        if (childManifest === undefined) continue
        await writeManifest(childDir, { ...childManifest, parentEntryId: parent.entryId })
      } catch (error) { /* the child entry is still independently usable */ }
    }
    return parent
  }

  /** Every readable trash entry, newest first. */
  async function listTrash() {
    let names
    try {
      names = await readdir(trashSessionsRoot())
    } catch (error) {
      return []
    }
    const entries = []
    for (const name of names.slice(0, MAX_TRASH_ENTRIES)) {
      const manifest = await readManifest(join(trashSessionsRoot(), name))
      if (manifest !== undefined) entries.push(manifest)
    }
    entries.sort((left, right) => String(right.deletedAt ?? '').localeCompare(String(left.deletedAt ?? '')))
    return entries
  }

  /** Put one trashed session back where it came from. */
  async function restoreOne(entryId) {
    const entryDir = join(trashSessionsRoot(), entryId)
    const manifest = await readManifest(entryDir)
    if (manifest === undefined) {
      const error = new Error('entry-not-found')
      error.code = 'entry-not-found'
      throw error
    }
    const dataDir = join(entryDir, TRASH_DATA)
    const target = join(sessionsRoot(), manifest.originalPath)
    try {
      await stat(target)
      const error = new Error('target-exists')
      error.code = 'target-exists'
      error.detail = { sessionId: manifest.sessionId }
      throw error
    } catch (error) {
      if (error.code === 'target-exists') throw error
      // ENOENT is the expected path: nothing occupies the original location.
    }
    await mkdir(dirname(target), { recursive: true })
    await rename(dataDir, target)
    // Re-attach to the original workspace, else resolve the owner by cwd.
    const reg = registry()
    if (reg !== null) {
      try {
        let workspace = null
        if (typeof manifest.workspaceId === 'string' && manifest.workspaceId !== '') {
          workspace = reg.get(manifest.workspaceId) ?? null
        }
        if (workspace === null && typeof manifest.cwd === 'string' && manifest.cwd !== ''
          && typeof reg.resolveByPath === 'function') {
          workspace = await reg.resolveByPath(manifest.cwd)
        }
        if (workspace !== null && typeof workspace.attachSession === 'function') {
          await workspace.attachSession(manifest.sessionId)
        }
      } catch (error) {
        loggerWarn(`dsh-enhancer: 恢复后归组失败 ${manifest.sessionId} (${String(error?.message || error)})`)
      }
    }
    await rm(entryDir, { recursive: true, force: true })
    return manifest
  }

  /** Restore one entry and every child entry its deletion created. */
  async function restoreEntry(entryId) {
    const entryDir = join(trashSessionsRoot(), entryId)
    const manifest = await readManifest(entryDir)
    if (manifest === undefined) {
      const error = new Error('entry-not-found')
      error.code = 'entry-not-found'
      throw error
    }
    const restored = []
    if (Array.isArray(manifest.children)) {
      for (const child of manifest.children) {
        if (child === null || typeof child !== 'object' || typeof child.entryId !== 'string') continue
        try {
          restored.push(await restoreOne(child.entryId))
        } catch (error) { /* a separately purged child is simply gone */ }
      }
    }
    restored.push(await restoreOne(entryId))
    return restored
  }

  /** Permanently remove one trash entry directory. */
  async function purgeEntry(entryId) {
    const entryDir = join(trashSessionsRoot(), entryId)
    const manifest = await readManifest(entryDir)
    if (manifest === undefined) {
      const error = new Error('entry-not-found')
      error.code = 'entry-not-found'
      throw error
    }
    // A parent entry owns the child entries its deletion created.
    if (Array.isArray(manifest.children)) {
      for (const child of manifest.children) {
        if (child === null || typeof child !== 'object' || typeof child.entryId !== 'string') continue
        await rm(join(trashSessionsRoot(), child.entryId), { recursive: true, force: true }).catch(() => {})
      }
    }
    await rm(entryDir, { recursive: true, force: true })
    return manifest
  }

  /** Permanently remove every trash entry. Never touches `sessions/`. */
  async function emptyTrash() {
    let names
    try {
      names = await readdir(trashSessionsRoot())
    } catch (error) {
      return 0
    }
    let removed = 0
    for (const name of names) {
      try {
        await rm(join(trashSessionsRoot(), name), { recursive: true, force: true })
        removed += 1
      } catch (error) {
        loggerWarn(`dsh-enhancer: 删除回收站条目失败 ${name} (${String(error?.message || error)})`)
      }
    }
    return removed
  }

  /**
   * Drop hidden ids whose workspace no longer exists. Runs after load, on every
   * GET (so a deleted workspace never keeps a stale record in the file) and on
   * a slow timer. A registry hiccup keeps the id instead of losing state, and
   * an unavailable registry simply skips the pass.
   */
  async function pruneStale() {
    await loadState()
    if (state.hidden.length === 0) return false
    const reg = registry()
    if (reg === null) return false
    const kept = []
    let removed = 0
    for (const id of state.hidden) {
      try {
        if (reg.get(id) === undefined) removed += 1
        else kept.push(id)
      } catch (error) {
        kept.push(id)
      }
    }
    if (removed === 0) return false
    state = { ...state, hidden: kept, updatedAt: new Date().toISOString() }
    await persist()
    broadcast()
    loggerWarn(`dsh-enhancer: 已清理 ${removed} 个已不存在的工作区隐藏记录`)
    return true
  }

  /** Two normalized states describe the same visibility configuration. */
  function sameState(left, right) {
    if (left === null || right === null) return left === right
    if (left.hidden.length !== right.hidden.length
      || left.showHidden !== right.showHidden
      || left.legacyCleanupDone !== right.legacyCleanupDone) return false
    for (let index = 0; index < left.hidden.length; index += 1) {
      if (left.hidden[index] !== right.hidden[index]) return false
    }
    return true
  }

  /** Read the state file as another Host process may have left it. */
  async function readDiskState() {
    try {
      const info = await stat(file)
      if (info.size > MAX_STATE_FILE_BYTES) return null
      const raw = await readFile(file, 'utf8')
      return normalizeState(JSON.parse(raw))
    } catch (error) {
      return null
    }
  }

  /**
   * Best-effort cross-process write lock: `mkdir`-free O_EXCL lock file so a
   * Desktop mutation and a web mutation read-modify-write the same state
   * without losing each other. Falls back to an unlocked write if the lock
   * cannot be taken in time (a hung lock must never freeze the sidebar).
   */
  async function withFileLock(fn) {
    const lockFile = `${file}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    let handle = null
    for (;;) {
      try {
        handle = await open(lockFile, 'wx')
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') return await fn()
        try {
          const info = await stat(lockFile)
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await unlink(lockFile).catch(() => {})
            continue
          }
        } catch (statError) { /* the lock vanished meanwhile: retry */ }
        if (Date.now() >= deadline) return await fn()
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 40)))
      }
    }
    try {
      try { await handle.writeFile(String(process.pid)) } catch (error) { /* diagnostics only */ }
      return await fn()
    } finally {
      try { await handle.close() } catch (error) { /* ignore */ }
      try { await unlink(lockFile) } catch (error) { /* ignore */ }
    }
  }

  /**
   * Pull changes written by another Host process (Desktop ↔ web share one
   * `DSH_HOME`). Only touched when the file version actually moves, and our
   * own writes are ignored via a content comparison, so no echo broadcasts.
   */
  async function pollStateFile() {
    try {
      const info = await stat(file)
      if (info.mtimeMs === lastSeenMtimeMs && info.size === lastSeenSize) return
      lastSeenMtimeMs = info.mtimeMs
      lastSeenSize = info.size
      const disk = await readDiskState()
      if (disk === null) return
      await loadState()
      if (state !== null && sameState(disk, state)) return
      state = disk
      broadcast()
    } catch (error) { /* the file may vanish between stat and read */ }
  }

  function broadcast() {
    const payload = `data: ${JSON.stringify(state)}\n\n`
    for (const res of Array.from(streams)) {
      try {
        res.write(payload)
      } catch {
        streams.delete(res)
      }
    }
  }

  /** Queue one atomic write of the current in-memory state. */
  function persist() {
    const snapshot = `${JSON.stringify(state, null, 2)}\n`
    writeChain = writeChain.then(async () => {
      const dir = dirname(file)
      await mkdir(dir, { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, file)
    }).catch((error) => {
      loggerWarn(`dsh-enhancer: 写入状态失败 (${String(error?.message || error)})`)
    })
    return writeChain
  }

  /**
   * Apply one incremental mutation. Increments (not whole-state PUTs) keep two
   * clients that hide different workspaces from overwriting each other.
   */
  function applyMutation(base, payload) {
    const type = payload?.type
    const value = payload?.value === true
    if (type === 'setHidden' || type === 'toggleHidden') {
      const requested = typeof payload?.workspaceId === 'string' ? payload.workspaceId.trim() : ''
      if (requested === '' || requested.length > 200) throw new Error('workspaceId is required')
      if (value === true || type === 'toggleHidden') {
        // Never persist a hide for a workspace the registry does not know
        // (a stale client or a deleted workspace). Registry hiccups keep the
        // request instead of dropping it.
        const reg = registry()
        if (reg !== null) {
          let exists = true
          try { exists = reg.get(requested) !== undefined } catch (error) { exists = true }
          if (!exists) return base
        }
      }
      const hidden = new Set(base.hidden)
      const next = type === 'toggleHidden' ? !hidden.has(requested) : value
      if (next === hidden.has(requested)) return base
      if (next) hidden.add(requested)
      else hidden.delete(requested)
      return {
        ...base,
        hidden: uniqueIds(Array.from(hidden)),
        updatedAt: new Date().toISOString(),
      }
    }
    if (type === 'setShowHidden') {
      if (base.showHidden === value) return base
      return { ...base, showHidden: value, updatedAt: new Date().toISOString() }
    }
    if (type === 'setLegacyCleanupDone') {
      if (base.legacyCleanupDone === value) return base
      return { ...base, legacyCleanupDone: value, updatedAt: new Date().toISOString() }
    }
    throw new Error(`unknown mutation type: ${String(type)}`)
  }

  /**
   * Apply one incremental mutation.
   *
   * The file is read-modify-written under a cross-process lock: Desktop and
   * `dsh web` are separate Host processes sharing one state file, so a blind
   * in-memory overwrite could drop the other instance's change. If the lock
   * cannot be taken the mutation still applies, just without the merge.
   */
  async function mutate(payload) {
    await loadState()
    return withFileLock(async () => {
      const disk = await readDiskState()
      if (disk !== null && !sameState(disk, state)) {
        // Another Host process changed the state while this one was idle.
        state = disk
        broadcast()
      }
      const next = applyMutation(state, payload)
      if (next === state) return state
      state = next
      await persist()
      broadcast()
      return state
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sub = url.pathname.slice(PREFIX.length)

    if (req.method === 'GET' && (sub === '/state' || sub === '/')) {
      await loadState()
      await pruneStale()
      sendJson(res, 200, state)
      return
    }

    if (req.method === 'POST' && sub === '/mutate') {
      const payload = await readJsonBody(req)
      sendJson(res, 200, await mutate(payload))
      return
    }

    /**
     * Open one workspace directory in the system file manager.
     *
     * The browser only names a workspace id; the path is resolved here from the
     * shipped registry, so a page can never ask the Host to open an arbitrary
     * directory. `status()` is checked first because `open` on a deleted folder
     * either fails silently or surfaces a raw OS dialog.
     */
    if (req.method === 'POST' && sub === '/open-workspace') {
      const payload = await readJsonBody(req)
      const workspaceId = typeof payload?.workspaceId === 'string' ? payload.workspaceId.trim() : ''
      if (workspaceId === '' || workspaceId.length > 200) {
        sendJson(res, 400, { ok: false, error: 'workspace-required' })
        return
      }
      const reg = registry()
      if (reg === null) {
        sendJson(res, 503, { ok: false, error: 'registry-unavailable' })
        return
      }
      let workspace = null
      try { workspace = reg.get(workspaceId) ?? null } catch (error) { workspace = null }
      if (workspace === null || workspace === undefined) {
        sendJson(res, 404, { ok: false, error: 'workspace-not-found' })
        return
      }
      const workspacePath = typeof workspace.path === 'string' ? workspace.path : ''
      if (workspacePath === '') {
        sendJson(res, 404, { ok: false, error: 'workspace-path-missing' })
        return
      }
      let status = 'ok'
      try { status = await workspace.status() } catch (error) { status = 'ok' }
      if (status === 'missing-dir') {
        sendJson(res, 409, { ok: false, error: 'missing-dir', path: workspacePath })
        return
      }
      try {
        await openFolder(workspacePath)
      } catch (error) {
        loggerWarn(`dsh-enhancer: 无法打开工作区目录 (${String(error?.message || error)})`)
        sendJson(res, 500, {
          ok: false,
          error: 'open-failed',
          path: workspacePath,
          message: String(error?.message || error),
        })
        return
      }
      sendJson(res, 200, { ok: true, path: workspacePath })
      return
    }

    /* ------------------------------------------------------------------ *
     * Session trash routes                                                *
     * ------------------------------------------------------------------ */

    if (req.method === 'GET' && sub === '/trash') {
      sendJson(res, 200, { ok: true, entries: await listTrash() })
      return
    }

    if (req.method === 'POST' && sub === '/trash/inspect') {
      const payload = await readJsonBody(req)
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (sessionId === '' || sessionId.length > 200) {
        sendJson(res, 400, { ok: false, error: 'session-required' })
        return
      }
      sendJson(res, 200, { ok: true, ...(await inspectSession(sessionId)) })
      return
    }

    if (req.method === 'POST' && sub === '/trash/move') {
      const payload = await readJsonBody(req)
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (sessionId === '' || sessionId.length > 200) {
        sendJson(res, 400, { ok: false, error: 'session-required' })
        return
      }
      try {
        const entry = await moveSessionToTrash(
          sessionId,
          payload?.includeChildren === true,
          typeof payload?.displayTitle === 'string' ? payload.displayTitle : '',
        )
        sendJson(res, 200, { ok: true, entry })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'trash-failed'
        const status = code === 'session-not-found'
          ? 404
          : (code === 'session-running' || code === 'child-running')
            ? 409
            : 500
        sendJson(res, status, {
          ok: false,
          error: code,
          message: String(error?.message || error),
          detail: error?.detail ?? null,
        })
      }
      return
    }

    if (req.method === 'POST' && sub === '/trash/restore') {
      const payload = await readJsonBody(req)
      const entryIds = Array.isArray(payload?.entryIds)
        ? payload.entryIds.filter((id) => typeof id === 'string' && id !== '')
        : []
      if (entryIds.length === 0) {
        sendJson(res, 400, { ok: false, error: 'entry-required' })
        return
      }
      const restored = []
      const failed = []
      for (const entryId of entryIds.slice(0, 200)) {
        try {
          const manifests = await restoreEntry(entryId)
          for (const manifest of manifests) restored.push({ entryId: manifest.entryId, sessionId: manifest.sessionId })
        } catch (error) {
          failed.push({ entryId, error: typeof error?.code === 'string' ? error.code : 'restore-failed' })
        }
      }
      sendJson(res, 200, { ok: failed.length === 0, restored, failed })
      return
    }

    if (req.method === 'POST' && sub === '/trash/purge') {
      const payload = await readJsonBody(req)
      const entryIds = Array.isArray(payload?.entryIds)
        ? payload.entryIds.filter((id) => typeof id === 'string' && id !== '')
        : []
      if (entryIds.length === 0) {
        sendJson(res, 400, { ok: false, error: 'entry-required' })
        return
      }
      const purged = []
      const failed = []
      for (const entryId of entryIds.slice(0, 200)) {
        try {
          const manifest = await purgeEntry(entryId)
          purged.push({ entryId: manifest.entryId, sessionId: manifest.sessionId })
        } catch (error) {
          failed.push({ entryId, error: typeof error?.code === 'string' ? error.code : 'purge-failed' })
        }
      }
      sendJson(res, 200, { ok: failed.length === 0, purged, failed })
      return
    }

    if (req.method === 'POST' && sub === '/trash/empty') {
      sendJson(res, 200, { ok: true, removed: await emptyTrash() })
      return
    }

    if (req.method === 'GET' && sub === '/stream') {
      const current = await loadState()
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      res.write(`data: ${JSON.stringify(current)}\n\n`)
      streams.add(res)
      const ping = setInterval(() => {
        try { res.write(': ping\n\n') } catch { /* the close handler cleans up */ }
      }, STREAM_PING_MS)
      const cleanup = () => {
        clearInterval(ping)
        streams.delete(res)
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  ctx.effect(() => {
    disposeRoutes()
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        try {
          await handle(req, res)
        } catch (error) {
          loggerWarn(`dsh-enhancer: 请求失败 (${String(error?.message || error)})`)
          if (!res.headersSent) {
            sendJson(res, 400, { error: String(error?.message || error) })
          } else {
            try { res.end() } catch { /* already closed */ }
          }
        }
      },
    })
    const mine = () => {
      try { disposeRoute() } catch { /* ignore */ }
      for (const res of Array.from(streams)) {
        try { res.end() } catch { /* ignore */ }
      }
      streams.clear()
    }
    ROUTES_HOLDER.value = mine
    const pruneTimer = setInterval(() => {
      if (streams.size === 0 && state !== null && state.hidden.length === 0) return
      pruneStale().catch((error) => loggerWarn(`dsh-enhancer: 清理失效记录失败 (${String(error?.message || error)})`))
    }, PRUNE_INTERVAL_MS)
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref()
    return () => {
      clearInterval(pruneTimer)
      if (ROUTES_HOLDER.value !== mine) return
      ROUTES_HOLDER.value = undefined
      mine()
    }
  }, 'dsh-enhancer: host state routes')

  // Desktop and `dsh web` are separate Host processes sharing this file; the
  // poll is what makes a change in one surface show up in the other (< 1 s).
  ctx.effect(() => {
    const timer = setInterval(() => {
      pollStateFile().catch(() => { /* stat/read races are expected */ })
    }, POLL_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-enhancer: cross-process state watch')
}
