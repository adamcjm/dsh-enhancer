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
  return { state, calls, fetchFn, FakeEventSource, sources }
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
equal('inject waits for locale/workspaces', loaded.exports.inject, ['locale', 'workspaces'])
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
  check('apply registers no sidebar slot components (footer button removed)', registrations.length === 0,
    `registrations=${registrations.length}`)
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
 * Report                                                               *
 * ------------------------------------------------------------------ */
const failed = checks.filter((item) => !item.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.error('\nFailures:')
  for (const item of failed) console.error(` - ${item.name}${item.detail === undefined ? '' : ` (${item.detail})`}`)
  process.exit(1)
}
