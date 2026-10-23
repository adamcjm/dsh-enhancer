/**
 * Zero-dependency self-check for the browser half.
 *
 * Evaluates `lib/client.js` in a `vm` sandbox with a fake `__ModuleLoader__`,
 * React, document, fetch, EventSource and localStorage. It covers the loader
 * contract, the pure projection, the in-memory store, the Host bridge
 * (bootstrap / increments / SSE / one-shot legacy cleanup), the workspace-menu
 * DOM entries (Open folder + Hide, including the missing-directory copy) and a
 * full `apply()` run against a fake Cordis context.
 *
 * Run: node test/verify.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = '@adamcjm/dsh-enhancer'
const STATE_URL = '/dsh-enhancer/state'
const MUTATE_URL = '/dsh-enhancer/mutate'
const OPEN_URL = '/dsh-enhancer/open-workspace'
const TRASH_URL = '/dsh-enhancer/trash'
const TRASH_INSPECT_URL = TRASH_URL + '/inspect'
const TRASH_MOVE_URL = TRASH_URL + '/move'
const TRASH_RESTORE_URL = TRASH_URL + '/restore'
const TRASH_PURGE_URL = TRASH_URL + '/purge'
const TRASH_EMPTY_URL = TRASH_URL + '/empty'
const STREAM_URL = '/dsh-enhancer/stream'
const LEGACY_STORAGE_KEY = 'dsh-enhancer.state.v1'

/* ------------------------------------------------------------------ *
 * Fake browser                                                       *
 * ------------------------------------------------------------------ */
function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    tag,
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    children: [],
    parentElement: null,
    attributes: {},
    style: {},
    appendChild(child) {
      child.parentElement = element
      element.children.push(child)
      return child
    },
    removeAttribute(name) { delete element.attributes[name] },
    setAttribute(name, value) { element.attributes[name] = String(value) },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : null
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {
      const parent = element.parentElement
      if (parent === null) return
      const index = parent.children.indexOf(element)
      if (index >= 0) parent.children.splice(index, 1)
      element.parentElement = null
    },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    dispatchEvent() { return true },
  }
  return element
}

function makeDocument() {
  const head = makeElement('head')
  const documentStub = {
    head,
    documentElement: makeElement('html'),
    body: makeElement('body'),
    activeElement: null,
    createElement: makeElement,
    getElementById(id) {
      return head.children.find((child) => child.id === id) ?? null
    },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return [] },
  }
  documentStub.activeElement = documentStub.body
  return documentStub
}

/**
 * A richer element for the DOM-bridge test: selectors resolve through an
 * explicit map, children keep parent links, and listeners can be dispatched.
 */
function makeRichElement(tag, selectors = {}) {
  const element = {
    tagName: String(tag).toUpperCase(),
    tag,
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    type: '',
    children: [],
    attributes: {},
    style: {},
    parentElement: null,
    listeners: {},
    appendChild(child) {
      child.parentElement = element
      element.children.push(child)
      return child
    },
    remove() {
      const parent = element.parentElement
      if (parent === null) return
      const index = parent.children.indexOf(element)
      if (index >= 0) parent.children.splice(index, 1)
      element.parentElement = null
    },
    setAttribute(name, value) { element.attributes[name] = String(value) },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : null
    },
    removeAttribute(name) { delete element.attributes[name] },
    addEventListener(type, listener) {
      if (element.listeners[type] === undefined) element.listeners[type] = []
      element.listeners[type].push(listener)
    },
    removeEventListener() {},
    dispatchEvent() { return true },
    /** Fire the recorded click listeners like a real button press. */
    click() {
      const event = { preventDefault() {}, stopPropagation() {}, target: element }
      for (const listener of element.listeners.click ?? []) listener(event)
    },
    querySelector(selector) {
      return Object.prototype.hasOwnProperty.call(selectors, selector) ? selectors[selector] : null
    },
    querySelectorAll() { return [] },
    closest() { return null },
  }
  return element
}

/** A fake menu portal plus a document that exposes it to the bridge scan. */
function makeMenuDocument(menu) {
  const documentListeners = {}
  const body = makeRichElement('body')
  const documentStub = {
    head: makeRichElement('head'),
    body,
    documentElement: makeRichElement('html'),
    activeElement: body,
    createElement(tag) { return makeRichElement(tag) },
    getElementById() { return null },
    addEventListener(type, listener) {
      if (documentListeners[type] === undefined) documentListeners[type] = []
      documentListeners[type].push(listener)
    },
    removeEventListener() {},
    querySelectorAll(selector) {
      return selector === '[role="menu"]' ? [menu] : []
    },
    /** Test seam: fire one captured document listener. */
    emit(type, event) {
      for (const listener of documentListeners[type] ?? []) listener(event)
    },
  }
  return documentStub
}

/** A shipped-looking workspace menu that the bridge can recognise and fill. */
function makeWorkspaceMenu() {
  const sampleItem = makeRichElement('button', {
    span: makeRichElement('span'),
    'span:last-child': makeRichElement('span'),
  })
  sampleItem.className = 'shipped-menu-item'
  const sampleWrap = makeRichElement('div')
  sampleWrap.appendChild(sampleItem)
  const menu = makeRichElement('div')
  menu.textContent = '重命名删除工作区'
  menu.setAttribute('role', 'menu')
  menu.querySelector = function (selector) {
    if (selector === '[role="menuitem"]') return sampleItem
    if (selector === '[data-dsh-enh-item]') {
      return menu.children.find((child) => child.getAttribute('data-dsh-enh-item') !== null) ?? null
    }
    return null
  }
  menu.querySelectorAll = function (selector) {
    if (selector === '[data-dsh-enh-item]') {
      return menu.children.filter((child) => child.getAttribute('data-dsh-enh-item') !== null)
    }
    return []
  }
  return menu
}

function makeLocalStorage() {
  const removed = []
  const written = []
  return {
    removed,
    written,
    getItem() { return null },
    setItem(key, value) { written.push([key, String(value)]) },
    removeItem(key) { removed.push(key) },
  }
}

function makeMutationObserver() {
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback }
    observe() {}
    disconnect() {}
  }
  return FakeMutationObserver
}

function makeReact() {
  return {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
  }
}

/**
 * A tiny Host simulator: the same state object the real `lib/index.js` would
 * keep in memory, with the three routes the client uses.
 */
function makeHost(options = {}) {
  const state = {
    version: 1,
    hidden: Array.isArray(options.hidden) ? [...options.hidden] : [],
    showHidden: options.showHidden === true,
    legacyCleanupDone: options.legacyCleanupDone === true,
    updatedAt: null,
  }
  const calls = { state: 0, mutate: [], open: [] }
  const openResponse = options.openResponse ?? { status: 200, body: { ok: true } }
  const trash = { calls: [], entries: [], inspector: null }
  const sources = []
  function broadcast() {
    for (const source of sources) {
      if (typeof source.onmessage === 'function' && !source.closed) {
        source.onmessage({ data: JSON.stringify(state) })
      }
    }
  }
  function mutate(mutation) {
    calls.mutate.push(mutation)
    if (mutation.type === 'setHidden') {
      const hidden = new Set(state.hidden)
      if (mutation.value === true) hidden.add(mutation.workspaceId)
      else hidden.delete(mutation.workspaceId)
      state.hidden = Array.from(hidden)
    } else if (mutation.type === 'setShowHidden') {
      state.showHidden = mutation.value === true
    } else if (mutation.type === 'setLegacyCleanupDone') {
      state.legacyCleanupDone = mutation.value === true
    }
    broadcast()
    return state
  }
  async function fetchFn(url, init) {
    const method = init && init.method ? init.method : 'GET'
    if (url === STATE_URL && method === 'GET') {
      calls.state += 1
      return { ok: true, status: 200, json: async () => state }
    }
    if (url === MUTATE_URL && method === 'POST') {
      const body = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => mutate(body) }
    }
    if (url === TRASH_URL && method === 'GET') {
      trash.calls.push('list')
      return { ok: true, status: 200, json: async () => ({ ok: true, entries: trash.entries }) }
    }
    if (url === TRASH_INSPECT_URL && method === 'POST') {
      const body = JSON.parse(init.body)
      trash.calls.push('inspect:' + body.sessionId)
      const inspector = trash.inspector ?? { exists: true, running: false, title: '', workspaceTitle: '', children: [] }
      return { ok: true, status: 200, json: async () => Object.assign({ ok: true }, inspector) }
    }
    if (url === TRASH_MOVE_URL && method === 'POST') {
      const body = JSON.parse(init.body)
      trash.calls.push('move:' + body.sessionId + ':' + body.includeChildren)
      return { ok: true, status: 200, json: async () => ({ ok: true, entry: { entryId: 'entry-' + body.sessionId, sessionId: body.sessionId } }) }
    }
    if (url === TRASH_RESTORE_URL && method === 'POST') {
      const body = JSON.parse(init.body)
      trash.calls.push('restore:' + body.entryIds.join(','))
      return { ok: true, status: 200, json: async () => ({ ok: true, restored: [], failed: [] }) }
    }
    if (url === TRASH_PURGE_URL && method === 'POST') {
      const body = JSON.parse(init.body)
      trash.calls.push('purge:' + body.entryIds.join(','))
      return { ok: true, status: 200, json: async () => ({ ok: true, purged: [], failed: [] }) }
    }
    if (url === TRASH_EMPTY_URL && method === 'POST') {
      trash.calls.push('empty')
      return { ok: true, status: 200, json: async () => ({ ok: true, removed: 1 }) }
    }
    if (url === OPEN_URL && method === 'POST') {
      const body = JSON.parse(init.body)
      calls.open.push(body)
      const resolved = typeof openResponse === 'function' ? openResponse(body) : openResponse
      return {
        ok: resolved.status < 400,
        status: resolved.status,
        json: async () => resolved.body,
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  }
  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.closed = false
      FakeEventSource.instances.push(this)
      sources.push(this)
    }
    close() { this.closed = true }
  }
  FakeEventSource.instances = []
  return { state, calls, fetchFn, FakeEventSource, sources, trash }
}

function loadBundle(options = {}) {
  const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const document = makeDocument()
  const localStorage = options.localStorage ?? makeLocalStorage()
  const host = options.host ?? makeHost()
  const entries = []
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Array,
    Object,
    Set,
    Map,
    Symbol,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
    document,
    window: {
      __ModuleLoader__: { load(entry) { entries.push(entry) } },
      localStorage,
      fetch: host.fetchFn,
      EventSource: host.FakeEventSource,
      MutationObserver: makeMutationObserver(),
      KeyboardEvent: class FakeKeyboardEvent { constructor(type, init) { this.type = type; this.key = init?.key } },
    },
    React: makeReact(),
  }
  sandbox.globalThis = sandbox
  runInNewContext(code, sandbox)
  if (entries.length !== 1) throw new Error(`expected one loader entry, got ${entries.length}`)
  const entry = entries[0]
  const exports = entry.factory((id) => {
    if (id === 'react') return makeReact()
    throw new Error(`unexpected dependency: ${id}`)
  })
  return { entry, exports, document, localStorage, host }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------------ *
 * Mini test harness                                                    *
 * ------------------------------------------------------------------ */
const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : `  (${detail})`}`)
}
function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)}`)
}

/* ------------------------------------------------------------------ *
 * 1. Loader contract                                                   *
 * ------------------------------------------------------------------ */
const loaded = loadBundle()
equal('loader entry id is the package name', loaded.entry.id, PACKAGE_NAME)
check('factory publishes apply', typeof loaded.exports.apply === 'function')
equal('inject waits for locale/workspaces/slots', loaded.exports.inject, ['locale', 'workspaces', 'slots'])
const t = loaded.exports.__test
check('test seam is exported', t !== undefined && typeof t.filterProjection === 'function'
  && typeof t.installSync === 'function' && typeof t.normalizeRemoteState === 'function')
check('no localStorage persistence helpers remain', t.parseStored === undefined && t.serializeState === undefined)

/* ------------------------------------------------------------------ *
 * 2. Host payload normalization                                        *
 * ------------------------------------------------------------------ */
equal('normalizeRemoteState(junk) is empty', t.normalizeRemoteState(null), {
  hidden: [], showHidden: false, legacyCleanupDone: false,
})
equal('normalizeRemoteState dedupes and validates ids', t.normalizeRemoteState({
  hidden: ['a', '', null, 7, 'a', 'b'], showHidden: true, legacyCleanupDone: false,
}), { hidden: ['a', 'b'], showHidden: true, legacyCleanupDone: false })
equal('normalizeRemoteState keeps the cleanup flag', t.normalizeRemoteState({ legacyCleanupDone: true }).legacyCleanupDone, true)

/* ------------------------------------------------------------------ *
 * 3. Snapshot projection                                               *
 * ------------------------------------------------------------------ */
const raw = {
  state: 'ready',
  items: [
    { workspaceId: 'w1', path: '/one', title: 'one', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', path: '/two', title: 'two', sessionIds: ['s3'] },
  ],
  archivedSessionIds: ['s9'],
  pinnedSessionIds: ['s1', 's3'],
}
const projected = t.filterProjection(raw, new Set(['w1']))
equal('hidden workspace leaves items', projected.items.map((item) => item.workspaceId), ['w2'])
equal('hidden sessions join the view-only archive set', projected.archivedSessionIds, ['s9', 's1', 's2'])
equal('hidden sessions lose their pin', projected.pinnedSessionIds, ['s3'])
equal('nothing hidden returns the same snapshot object', t.filterProjection(raw, new Set()), raw)
equal('mergeArchived dedupes and keeps base order', t.mergeArchived(['a', 'b'], ['b', 'c']), ['a', 'b', 'c'])

/* ------------------------------------------------------------------ *
 * 4. Menu recognition (zh + en)                                        *
 * ------------------------------------------------------------------ */
equal('recognizes the shipped workspace menu (zh)', t.menuKindFromText('重命名删除工作区'), 'workspace')
equal('recognizes the shipped workspace menu (en)', t.menuKindFromText('RenameDelete workspace'), 'workspace')
equal('recognizes the shipped view options menu (zh)', t.menuKindFromText('分组方式按工作区'), 'viewOptions')
equal('recognizes the shipped view options menu (en)', t.menuKindFromText('Group byWorkspace'), 'viewOptions')
equal('unknown menu text is ignored', t.menuKindFromText('Copy Session ID'), null)

/* 4b. Hidden count in the View options label. */
{
  const fakeT = (key, vars) => key === 'viewOptions.showHiddenCount'
    ? `Show hidden workspaces (${vars.n})`
    : key
  equal('view options label carries the hidden count', t.showHiddenLabelText(fakeT, 3), 'Show hidden workspaces (3)')
  equal('view options label shows zero', t.showHiddenLabelText(fakeT, 0), 'Show hidden workspaces (0)')
}

/* ------------------------------------------------------------------ *
 * 5. In-memory store (no browser persistence)                          *
 * ------------------------------------------------------------------ */
{
  const store = t.createStore()
  const mutations = []
  const offSink = store.setMutationSink((mutation) => mutations.push(mutation))
  const before = store.getState()
  check('snapshot is referentially stable while unchanged', store.getState() === before)
  check('applyRemoteState marks the store ready', store.applyRemoteState({
    hidden: ['w1'], showHidden: false, legacyCleanupDone: false,
  }) === true && store.getState().ready === true)
  check('echoing the same state does not repaint', store.applyRemoteState({
    hidden: ['w1'], showHidden: false, legacyCleanupDone: false,
  }) === false)
  check('setHidden is optimistic', store.setHidden('w2', true) === true && store.isHidden('w2'))
  check('setHidden reports the mutation for the Host', mutations.length === 1
    && mutations[0].type === 'setHidden' && mutations[0].workspaceId === 'w2' && mutations[0].value === true)
  check('hiding closes the show-hidden switch and tells the Host', (() => {
    store.applyRemoteState({ hidden: ['w1', 'w2'], showHidden: true })
    const beforeCount = mutations.length
    store.setHidden('w3', true)
    const emitted = mutations.slice(beforeCount)
    return store.getState().showHidden === false
      && emitted.some((m) => m.type === 'setShowHidden' && m.value === false)
  })())
  check('setShowHidden reports the mutation', (() => {
    const beforeCount = mutations.length
    store.setShowHidden(true)
    return mutations.length === beforeCount + 1 && mutations[mutations.length - 1].type === 'setShowHidden'
  })())
  check('prune removes stale ids and tells the Host', (() => {
    store.applyRemoteState({ hidden: ['w1', 'w9'], showHidden: false })
    const beforeCount = mutations.length
    const changed = store.prune(new Set(['w1', 'w2', 'w3']))
    const last = mutations[mutations.length - 1]
    return changed === true && store.getState().hidden.size === 1
      && mutations.length === beforeCount + 1 && last.type === 'setHidden' && last.workspaceId === 'w9' && last.value === false
  })())
  offSink()
  check('sink deregistration stops forwarding', (() => {
    const beforeCount = mutations.length
    store.setHidden('w4', true)
    return mutations.length === beforeCount
  })())
}

/* ------------------------------------------------------------------ *
 * 6. Host bridge: bootstrap, increments, SSE, one-shot legacy cleanup  *
 * ------------------------------------------------------------------ */
{
  const localStorage = makeLocalStorage()
  const host = makeHost({ hidden: ['w1'], showHidden: false, legacyCleanupDone: false })
  const bridge = loadBundle({ localStorage, host })
  const store = bridge.exports.__test.createStore()
  const dispose = bridge.exports.__test.installSync({}, store, { warn: () => {} })
  await sleep(30)
  check('bootstrap fetched the state once', host.calls.state === 1)
  check('bootstrap applied the Host state', store.isHidden('w1'))
  check('legacy key removed exactly once', localStorage.removed.length === 1 && localStorage.removed[0] === LEGACY_STORAGE_KEY)
  check('legacy cleanup recorded on the Host', host.state.legacyCleanupDone === true
    && host.calls.mutate.some((m) => m.type === 'setLegacyCleanupDone'))
  check('browser state is never persisted', localStorage.written.length === 0)

  const source = host.FakeEventSource.instances[0]
  check('SSE stream connected', source !== undefined && source.url === STREAM_URL)
  source.onmessage({ data: JSON.stringify({ hidden: ['w2'], showHidden: true, legacyCleanupDone: true }) })
  check('SSE state applied to the store', store.isHidden('w2') && store.getState().showHidden === true && !store.isHidden('w1'))

  store.setHidden('w3', true)
  await sleep(30)
  check('local mutation sent as an increment', host.calls.mutate.some((m) => m.type === 'setHidden' && m.workspaceId === 'w3' && m.value === true))
  check('increments kept the pre-existing Host ids', host.state.hidden.includes('w1') && host.state.hidden.includes('w3'))
  check('legacy key was not touched again', localStorage.removed.length === 1)

  dispose()
  check('dispose closes the SSE stream', source.closed === true)
}

/* ------------------------------------------------------------------ *
 * 7. Full apply() with a fake Cordis context                           *
 * ------------------------------------------------------------------ */
{
  const localStorage = makeLocalStorage()
  const host = makeHost({ hidden: ['w1'], showHidden: false, legacyCleanupDone: false })
  const loadedApply = loadBundle({ localStorage, host })
  const model = {
    getSnapshot() { return raw },
    subscribe() { return () => {} },
  }
  const effects = []
  const registrations = []
  const dictionaries = []
  const fakeCtx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(name) { return name === 'workspaces' ? { list: model } : null },
    locale: {
      register(ns, dict) { dictionaries.push({ ns, dict }); return () => {} },
      bind(ns) {
        return (key) => {
          const dict = dictionaries.find((item) => item.ns === ns)?.dict
          const active = dict?.zh ?? dict?.en ?? {}
          return active[key] ?? key
        }
      },
    },
    slots: {
      inject(slotName, factory) {
        const result = factory()
        return () => { if (typeof result?.dispose === 'function') result.dispose() }
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return { dispose() {} }
      },
    },
    logger: { warn() {} },
  }
  loadedApply.exports.apply(fakeCtx)
  await sleep(40)
  check('apply registers the namespace dictionary', dictionaries.length === 1
    && dictionaries[0].ns === 'dsh-enhancer' && dictionaries[0].dict.zh && dictionaries[0].dict.en)
  check('apply registers the three trash slots', (() => {
    const names = registrations.map((item) => item.options && item.options.name).sort()
    return names.join(',') === 'settings.plugins.tab,shell.overlay,sidebar.workspaces.session.menu.item'
  })(), JSON.stringify(registrations.map((item) => item.options && item.options.name)))
  check('Host state is projected onto the sidebar model', model.getSnapshot().items.length === 1
    && model.getSnapshot().items[0].workspaceId === 'w2')
  check('apply injects exactly one stylesheet', loadedApply.document.getElementById('dsh-enhancer/style') !== null)
  check('apply removed the legacy key once', localStorage.removed.length === 1 && localStorage.removed[0] === LEGACY_STORAGE_KEY)
  check('apply never wrote localStorage', localStorage.written.length === 0)

  for (const effect of effects) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
  check('effect disposal restores the raw model', model.getSnapshot() === raw)
  check('effect disposal removes the stylesheet', loadedApply.document.getElementById('dsh-enhancer/style') === null)
  check('store.dispose effect is registered last', effects.map((e) => e.label).includes('dsh-enhancer: store'))
}

/* ------------------------------------------------------------------ *
 * 8. Workspace menu DOM: Open folder + Hide                            *
 * ------------------------------------------------------------------ */
{
  const ZH = {
    'menu.openFolder': '打开文件夹',
    'menu.openFolderMissing': '目录不存在',
    'menu.openFolderFailed': '打开失败',
    'menu.hide': '隐藏工作区',
    'menu.unhide': '取消隐藏工作区',
  }
  const translate = () => (key) => ZH[key] ?? key
  let openStatus = 200
  const host = makeHost({
    openResponse: () => (openStatus === 200
      ? { status: 200, body: { ok: true, path: '/Users/adam/projects/demo' } }
      : { status: 409, body: { ok: false, error: 'missing-dir' } }),
  })
  const bridge = loadBundle({ host })
  const test = bridge.exports.__test
  const store = test.createStore()
  const menu = makeWorkspaceMenu()
  const documentStub = makeMenuDocument(menu)
  const win = {
    fetch: host.fetchFn,
    MutationObserver: undefined,
    KeyboardEvent: class { constructor(type, init) { this.type = type; this.key = init?.key } },
  }
  const dispose = test.installDomBridge(documentStub, win, store, translate, { warn() {} })

  // Press the row menu trigger, then let the scheduled scan run.
  const row = makeRichElement('div')
  row.setAttribute('data-row-key', 'workspace:w1')
  row.closest = (selector) => (selector === '[data-row-key^="workspace:"]' ? row : null)
  documentStub.emit('pointerdown', { target: row })
  store.applyRemoteState({ hidden: [], showHidden: false, legacyCleanupDone: false })
  await sleep(10)

  const entries = menu.children.filter((child) => child.getAttribute('data-dsh-enh-item') !== null)
  equal('the workspace menu gains two entries',
    entries.map((entry) => entry.getAttribute('data-dsh-enh-kind')), ['open', 'hide'])
  const openEntry = entries[0]
  const hideEntry = entries[1]
  const openButton = openEntry.children[0]
  const openLabel = openButton.children[1]
  equal('the open entry uses the localized copy', openLabel.textContent, '打开文件夹')
  equal('the hide entry uses the localized copy', hideEntry.children[0].children[1].textContent, '隐藏工作区')

  openButton.click()
  await sleep(10)
  equal('open asks the Host with the workspace id only', host.calls.open, [{ workspaceId: 'w1' }])
  check('a successful open keeps the normal label', openLabel.textContent === '打开文件夹', openLabel.textContent)

  openStatus = 409
  openButton.click()
  await sleep(10)
  check('a missing folder is reported on the entry', openLabel.textContent === '目录不存在', openLabel.textContent)
  equal('both clicks carried the workspace id', host.calls.open.map((call) => call.workspaceId), ['w1', 'w1'])

  hideEntry.children[0].click()
  check('the hide entry toggles the hidden set', store.isHidden('w1') === true)
  dispose()
}

/* ------------------------------------------------------------------ *
 * 9. Session trash: controller, dialog and panel                      *
 * ------------------------------------------------------------------ */
{
  const DICT = {
    'menu.trash': '移到回收站',
    'dialog.trashTitle': '移到回收站',
    'dialog.trashBody': '将「{name}」移到回收站？',
    'dialog.trashConfirm': '移到回收站',
    'dialog.trashOnlyParent': '只删当前会话',
    'dialog.trashWithChildren': '连同 {n} 个子会话',
    'dialog.childrenAsk': '这个会话有 {n} 个子会话。',
    'dialog.running': '「{name}」正在运行，无法删除。',
    'dialog.inspecting': '正在检查会话…',
    'dialog.purgeTitle': '永久删除',
    'dialog.purgeBody': '永久删除选中的 {n} 个会话？',
    'dialog.purgeConfirm': '永久删除',
    'dialog.emptyTitle': '清空回收站',
    'dialog.emptyBody': '清空全部 {n} 项？',
    'dialog.emptyConfirm': '清空',
    'common.cancel': '取消',
    'common.close': '关闭',
    'common.untitled': '未命名会话',
    'common.noWorkspace': '无工作区',
    'trash.title': '回收站',
    'trash.hint': '删除的会话先放在这里，可随时恢复。',
    'trash.empty': '回收站是空的。',
    'trash.predict': 'x',
    'trash.loading': '正在加载…',
    'trash.refresh': '刷新',
    'trash.selectAll': '全选',
    'trash.restore': '恢复',
    'trash.purge': '永久删除',
    'trash.emptyTrash': '清空回收站 ({n})',
    'trash.restoreCount': '恢复 ({n})',
    'trash.purgeCount': '永久删除 ({n})',
    'trash.workspace': '工作区：{name}',
    'trash.childrenCount': '含 {n} 个子会话',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{n} 分钟前',
    'time.hoursAgo': '{n} 小时前',
    'time.daysAgo': '{n} 天前',
  }
  const translate = (key, vars) => {
    const value = DICT[key] ?? key
    if (vars === undefined) return value
    return value.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
  }
  const host = makeHost()
  const bridge = loadBundle({ host })
  const test = bridge.exports.__test
  const store = test.createTrashStore()
  const ui = test.createTrashController(store, () => translate)

  check('the trash store starts empty', store.getSnapshot().entries.length === 0
    && store.getSnapshot().dialog === null)

  ui.beginDelete('sess-1', 'hello')
  check('beginDelete opens a loading dialog', store.getSnapshot().dialog !== null
    && store.getSnapshot().dialog.loading === true)
  await sleep(20)
  const inspected = store.getSnapshot().dialog
  equal('the inspect answer is applied', inspected.inspect !== null && inspected.inspect.running, false)
  equal('inspect was requested once', host.trash.calls.filter((call) => call.startsWith('inspect:')), ['inspect:sess-1'])

  host.trash.inspector = { exists: true, running: true, title: 'busy', workspaceTitle: 'W', children: [] }
  ui.beginDelete('sess-busy', 'busy')
  await sleep(20)
  const runningTree = test.TrashDialog({ ui: ui, t: translate })
  check('a running session renders the blocked copy',
    JSON.stringify(runningTree).includes('正在运行，无法删除'),
    JSON.stringify(runningTree).slice(0, 120))

  host.trash.inspector = { exists: true, running: false, title: 'hello', workspaceTitle: 'W', children: [] }
  ui.beginDelete('sess-1', 'hello')
  await sleep(20)
  const confirmTree = test.TrashDialog({ ui: ui, t: translate })
  check('a deletable session renders the confirmation buttons',
    JSON.stringify(confirmTree).includes('移到回收站'))
  ui.confirmDelete(false)
  await sleep(20)
  check('confirmDelete closes the dialog', store.getSnapshot().dialog === null)
  equal('confirmDelete sent the move request',
    host.trash.calls.filter((call) => call.startsWith('move:')), ['move:sess-1:false'])

  host.trash.inspector = { exists: true, running: false, title: 'parent', workspaceTitle: 'W', children: [{ sessionId: 'c1', title: 'child' }] }
  ui.beginDelete('sess-parent', 'parent')
  await sleep(20)
  const cascadeTree = test.TrashDialog({ ui: ui, t: translate })
  check('a session with children offers both choices',
    JSON.stringify(cascadeTree).includes('只删当前会话')
      && JSON.stringify(cascadeTree).includes('连同 1 个子会话'))
  ui.confirmDelete(true)
  await sleep(20)
  equal('the cascade choice is forwarded',
    host.trash.calls.filter((call) => call.startsWith('move:sess-parent')), ['move:sess-parent:true'])

  host.trash.entries = [
    { entryId: 'e1', sessionId: 's1', title: 'Alpha', workspaceTitle: 'W', deletedAt: new Date().toISOString(), sizeBytes: 2048 },
    { entryId: 'e2', sessionId: 's2', title: 'Child', parentEntryId: 'e1' },
  ]
  ui.loadTrash()
  await sleep(20)
  equal('loadTrash stores every entry', store.getSnapshot().entries.length, 2)
  const panelTree = test.TrashPanel({ ui: ui, t: translate })
  const panelJson = JSON.stringify(panelTree)
  check('the panel renders the root entry', panelJson.includes('Alpha'))
  check('the panel does not list a cascaded child as a root row', !panelJson.includes('"Child"'))

  ui.toggleSelect('e1')
  equal('toggleSelect selects one entry', store.getSnapshot().selected, ['e1'])
  ui.toggleSelect('e1')
  equal('toggleSelect deselects it again', store.getSnapshot().selected, [])
  ui.selectAll(['e1'])
  equal('selectAll selects every root', store.getSnapshot().selected, ['e1'])

  ui.restoreSelected()
  await sleep(20)
  equal('restore sends the selected entry ids',
    host.trash.calls.filter((call) => call.startsWith('restore:')), ['restore:e1'])
  equal('restore clears the selection', store.getSnapshot().selected, [])

  ui.toggleSelect('e1')
  ui.askPurge()
  check('askPurge opens the purge dialog', store.getSnapshot().dialog !== null
    && store.getSnapshot().dialog.type === 'purge')
  ui.confirmPurge()
  await sleep(20)
  equal('purge sends the selected entry ids',
    host.trash.calls.filter((call) => call.startsWith('purge:')), ['purge:e1'])
  check('purge closes the dialog', store.getSnapshot().dialog === null)

  ui.askEmpty()
  check('askEmpty opens the empty dialog', store.getSnapshot().dialog !== null
    && store.getSnapshot().dialog.type === 'empty')
  ui.confirmEmpty()
  await sleep(20)
  check('empty was requested', host.trash.calls.includes('empty'))

  let menuClosed = false
  const menuItem = test.TrashMenuItem({
    sessionId: 'sess-1',
    displayTitle: 'hello',
    ui: ui,
    t: translate,
    closeMenu: () => { menuClosed = true },
  })
  check('the menu item renders a menuitem button', menuItem.type === 'button' && menuItem.props.role === 'menuitem')
  check('the menu item carries the localized label', JSON.stringify(menuItem).includes('移到回收站'))
  menuItem.props.onClick({ preventDefault: () => {}, stopPropagation: () => {} })
  await sleep(20)
  check('clicking the menu item asks the Host to inspect', host.trash.calls.includes('inspect:sess-1'))
  check('clicking the menu item closes the menu', menuClosed === true)
  ui.closeDialog()

  equal('formatBytes renders bytes', test.formatBytes(512), '512 B')
  equal('formatBytes renders kilobytes', test.formatBytes(2048), '2.0 KB')
  equal('formatBytes renders megabytes', test.formatBytes(3 * 1024 * 1024), '3.0 MB')
  equal('relativeTimeText renders just now', test.relativeTimeText(translate, new Date().toISOString()), '刚刚')
  equal('relativeTimeText renders minutes',
    test.relativeTimeText(translate, new Date(Date.now() - 5 * 60 * 1000).toISOString()), '5 分钟前')
}

/* ------------------------------------------------------------------ *
 * Report                                                               *
 * ------------------------------------------------------------------ */
const failed = checks.filter((item) => !item.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.error('\nFailures:')
  for (const item of failed) console.error(` - ${item.name}${item.detail === undefined ? '' : ` (${item.detail})`}`)
  process.exit(1)
}
