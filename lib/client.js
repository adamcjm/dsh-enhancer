/**
 * Browser half of `@adamcjm/dsh-enhancer`.
 *
 * WHAT IT DOES
 * ------------
 * Quality-of-life additions to the shipped workspace menus:
 *
 *   1. Every Workspace row's own "…" menu gains **Open folder**, which asks the
 *      Host to reveal that workspace's directory in Finder / Explorer / the
 *      platform's file manager.
 *   2. The same menu gains **Hide workspace**; while the hidden rows are shown
 *      again, the entry reads **Unhide workspace**.
 *   3. The sidebar **View options** menu gains a **Show hidden workspaces**
 *      switch that reveals every hidden workspace so it can be restored.
 *
 * Display only: nothing is archived, deleted, renamed or written into the
 * workspace registry, session logs or archive sets. Opening a folder is a
 * read-only side effect on the user's desktop.
 *
 * PERSISTENCE AND SYNC
 * --------------------
 * Hidden ids and the switch live on the Host in
 * `$DSH_HOME/storages/dsh-enhancer.json` (lib/index.js). The browser
 * keeps no copy: at boot the state is fetched once and then kept current by an
 * SSE stream (`/dsh-enhancer/stream`), so a change made in Desktop
 * reaches an open Web page (and other tabs/browsers sharing the same Host)
 * without a refresh — the same push model as the shipped `workspace/follow`
 * stream. Local mutations travel as increments, so two clients hiding
 * different workspaces cannot overwrite each other. On first start the Host
 * adopts the previous package's `workspace-visibility.json` once, so upgrading
 * keeps every hidden workspace.
 *
 * WHY THERE IS NO SLOT
 * --------------------
 * In DSH 0.2.1-rc the shipped sidebar (`@deepseek-ai/dsh-client-ui-workspace`)
 * exposes slots for *Session* row menus and *Session* row buttons, but the
 * Workspace row menu (`ProjectRowItem`'s `workspaceMenuItems`) and the View
 * options menu (`ViewOptionsMenu`) are hardcoded arrays with no slot. So the
 * entries are appended to those menus as DOM, exactly where the user asked for
 * them. The entries clone the shipped menu item's own classes, so a restyle
 * keeps them native-looking; nothing hardcodes a hashed CSS-module name.
 *
 * The *hiding* itself does not touch the DOM: the plugin wraps the
 * `workspaces.list` client model (`getSnapshot`/`subscribe`, the same seam the
 * shipped sidebar reads lazily) and projects a filtered snapshot. That makes
 * the sidebar, its search results and the Hero workspace picker disappear the
 * workspace in one place, and it keeps working even if the menu DOM changes.
 *
 * THE "UNGROUPED" PITFALL
 * -----------------------
 * The shipped grouping builds one group per *visible* workspace and trails
 * every session that is not accounted by a visible workspace into an
 * "Ungrouped" bucket (`groupByWorkspace` in ui-workspace). Simply removing a
 * workspace from `items` would therefore spill all of its sessions into
 * "Ungrouped". The projection instead marks those sessions as archived
 * (view-only union into `archivedSessionIds`), so the shipped sidebar's own
 * archive visibility filter keeps them out — no Host archive write, no data
 * loss. Consequence: with the shipped **All conversations (show archived)**
 * view selected, those sessions would appear as archived rows under
 * "Ungrouped"; the default **Hide archived** view — and the Unhide action —
 * keeps the sidebar identical.
 *
 * FORMAT
 * ------
 * Plain `window.__ModuleLoader__.load` factory, no build step: edit, refresh
 * the page, done. Only `react` is taken from the platform module table.
 */

try {
  window.__ModuleLoader__.load({
  id: '@adamcjm/dsh-enhancer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /* ------------------------------------------------------------------ *
     * React from the platform module table (fall back to the page global). *
     * ------------------------------------------------------------------ */
    let React = null
    try { React = require('react') } catch (error) { /* dynamic half: global fallback */ }
    if (!React) React = globalThis.React
    if (!React) throw new Error('dsh-enhancer: React runtime unavailable')
    const h = React.createElement
    const useSyncExternalStore = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : function fallbackUseSyncExternalStore(subscribe, getSnapshot) {
        // React < 18 fallback: re-render on every store notification.
        const value = React.useState(getSnapshot)[0]
        const force = React.useState(0)[1]
        React.useEffect(function () {
          let alive = true
          const off = subscribe(function () { if (alive) force(function (n) { return n + 1 }) })
          return function () { alive = false; if (typeof off === 'function') off() }
        }, [subscribe])
        return value
      }

    /* ------------------------------------------------------------------ *
     * Constants                                                          *
     * ------------------------------------------------------------------ */
    const NS = 'dsh-enhancer'
    /** Host HTTP surface owned by lib/index.js. */
    const API_PREFIX = '/dsh-enhancer'
    const STATE_URL = API_PREFIX + '/state'
    const MUTATE_URL = API_PREFIX + '/mutate'
    const OPEN_URL = API_PREFIX + '/open-workspace'
    const STREAM_URL = API_PREFIX + '/stream'
    /** 0.1.x kept the hidden set here; removed once, then never touched again. */
    const LEGACY_STORAGE_KEY = 'dsh-enhancer.state.v1'
    const STYLE_ID = 'dsh-enhancer/style'
    const MENU_FLAG = 'data-dsh-enh-item'
    const ROW_FLAG = 'data-dsh-enh-hidden-row'
    const INSTALL_MARK = Symbol.for('@adamcjm/dsh-enhancer/installed')
    /** Marks the `sessions.list` model wrapper so two instances never nest. */
    const TRASH_PROJECTION_MARK = Symbol.for('@adamcjm/dsh-enhancer/trash-projection')

    const WORKSPACE_ROW_SELECTOR = '[data-row-key^="workspace:"]'
    const MENU_SELECTOR = '[role="menu"]'
    const MENU_ITEM_SELECTOR = '[role="menuitem"]'
    const MENU_VIEWPORT_SELECTOR = '[class*="viewport"]'

    /** How long a row/button click may arm the next opened menu. */
    const ARM_TTL_MS = 2500

    /** Shipped copy used to recognise which menu just opened (zh + en). */
    const SHIPPED_TEXT = {
      rename: ['重命名', 'Rename'],
      deleteWorkspace: ['删除工作区', 'Delete workspace'],
      groupBy: ['分组方式', 'Group by'],
      viewOptionsAria: ['视图选项', 'View options'],
    }

    const EYE_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.2"><path d="M8 3.5c-2.9 0-5.3 2.1-6.3 4.5 1 2.4 3.4 4.5 6.3 4.5s5.3-2.1 6.3-4.5C13.3 5.6 10.9 3.5 8 3.5Z"/><circle cx="8" cy="8" r="1.9"/><path d="M2.5 13.5 13.5 2.5"/></svg>'
    const CHECK_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.6"><path d="m3.5 8.5 3 3 6-7"/></svg>'
    const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.2"><path d="M1.8 4.2c0-.6.5-1.1 1.1-1.1h2.9l1.3 1.4h5.9c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.2Z"/><path d="M1.8 6.2h12.4"/></svg>'

    /* ------------------------------------------------------------------ *
     * Dictionaries                                                        *
     * ------------------------------------------------------------------ */
    const zh = {
      'menu.openFolder': '打开文件夹',
      'menu.openFolderMissing': '目录不存在',
      'menu.openFolderFailed': '打开失败',
      'menu.trash': '移到回收站',
      'menu.hide': '隐藏工作区',
      'menu.unhide': '取消隐藏工作区',
      'viewOptions.showHidden': '显示隐藏工作区',
      'viewOptions.showHiddenCount': '显示隐藏工作区 ({n})',
      'trash.tab': '回收站',
      'trash.open': '回收站',
      'trash.title': '回收站',
      'trash.hint': '删除的会话先放在这里，可随时恢复。',
      'trash.empty': '回收站是空的。',
      'trash.loading': '正在加载…',
      'trash.refresh': '刷新',
      'trash.selectAll': '全选',
      'trash.restore': '恢复',
      'trash.restoreCount': '恢复 ({n})',
      'trash.purge': '永久删除',
      'trash.purgeCount': '永久删除 ({n})',
      'trash.emptyTrash': '清空回收站 ({n})',
      'trash.workspace': '工作区：{name}',
      'trash.childrenCount': '含 {n} 个子会话',
      'common.untitled': '未命名会话',
      'common.noWorkspace': '无工作区',
      'common.cancel': '取消',
      'common.close': '关闭',
      'dialog.trashTitle': '移到回收站',
      'dialog.trashBody': '将「{name}」移到回收站？会话不会立即删除，可在「设置 → 插件 → 回收站」里恢复。',
      'dialog.workspace': '所属工作区：{name}',
      'dialog.childrenAsk': '这个会话有 {n} 个子会话。要一起删掉吗？只删父会话会让子会话变成孤儿。',
      'dialog.trashOnlyParent': '只删当前会话',
      'dialog.trashWithChildren': '连同 {n} 个子会话',
      'dialog.trashConfirm': '移到回收站',
      'dialog.inspecting': '正在检查会话…',
      'dialog.running': '「{name}」正在运行，无法删除。请先停止它。',
      'dialog.trashFailedHint': '无法删除这个会话，请稍后重试。',
      'dialog.purgeTitle': '永久删除',
      'dialog.purgeBody': '永久删除选中的 {n} 个会话？会话会从回收站彻底移除，无法恢复。',
      'dialog.purgeConfirm': '永久删除',
      'dialog.emptyTitle': '清空回收站',
      'dialog.emptyBody': '清空全部 {n} 项？这会永久删除回收站里的所有会话，无法恢复。',
      'dialog.emptyConfirm': '清空',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'error.session-running': '会话正在运行，无法删除',
      'error.child-running': '有子会话正在运行，无法删除',
      'error.session-not-found': '会话不存在',
      'error.session-file-not-found': '找不到会话文件',
      'error.entry-not-found': '回收站条目不存在',
      'error.target-exists': '原位置已有同名会话',
      'error.restore-partial': '部分条目恢复失败',
      'error.purge-partial': '部分条目删除失败',
      'error.fetch-unavailable': '网络请求不可用',
      'error.request-failed': '请求失败',
      'error.trash-failed': '移到回收站失败',
      'error.restore-failed': '恢复失败',
      'error.purge-failed': '删除失败',
    }
    const en = {
      'menu.openFolder': 'Open folder',
      'menu.openFolderMissing': 'Folder no longer exists',
      'menu.openFolderFailed': 'Could not open',
      'menu.trash': 'Move to Trash',
      'menu.hide': 'Hide workspace',
      'menu.unhide': 'Unhide workspace',
      'viewOptions.showHidden': 'Show hidden workspaces',
      'viewOptions.showHiddenCount': 'Show hidden workspaces ({n})',
      'trash.tab': 'Trash',
      'trash.open': 'Trash',
      'trash.title': 'Trash',
      'trash.hint': 'Deleted sessions wait here and can be restored at any time.',
      'trash.empty': 'The trash is empty.',
      'trash.loading': 'Loading…',
      'trash.refresh': 'Refresh',
      'trash.selectAll': 'Select all',
      'trash.restore': 'Restore',
      'trash.restoreCount': 'Restore ({n})',
      'trash.purge': 'Delete permanently',
      'trash.purgeCount': 'Delete permanently ({n})',
      'trash.emptyTrash': 'Empty trash ({n})',
      'trash.workspace': 'Workspace: {name}',
      'trash.childrenCount': '{n} child sessions',
      'common.untitled': 'Untitled session',
      'common.noWorkspace': 'No workspace',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'dialog.trashTitle': 'Move to Trash',
      'dialog.trashBody': 'Move "{name}" to the trash? Nothing is deleted yet; restore it from Settings → Plugins → Trash.',
      'dialog.workspace': 'Workspace: {name}',
      'dialog.childrenAsk': 'This session has {n} child sessions. Delete them too? Keeping only the parent leaves them orphaned.',
      'dialog.trashOnlyParent': 'Delete only this session',
      'dialog.trashWithChildren': 'Delete with {n} child sessions',
      'dialog.trashConfirm': 'Move to Trash',
      'dialog.inspecting': 'Inspecting the session…',
      'dialog.running': '"{name}" is running and cannot be deleted. Stop it first.',
      'dialog.trashFailedHint': 'This session could not be deleted. Try again later.',
      'dialog.purgeTitle': 'Delete permanently',
      'dialog.purgeBody': 'Permanently delete the selected {n} sessions? They leave the trash and cannot be recovered.',
      'dialog.purgeConfirm': 'Delete permanently',
      'dialog.emptyTitle': 'Empty trash',
      'dialog.emptyBody': 'Empty all {n} entries? Every session in the trash is deleted permanently and cannot be recovered.',
      'dialog.emptyConfirm': 'Empty',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n} minutes ago',
      'time.hoursAgo': '{n} hours ago',
      'time.daysAgo': '{n} days ago',
      'error.session-running': 'The session is running and cannot be deleted',
      'error.child-running': 'A child session is running and cannot be deleted',
      'error.session-not-found': 'Session not found',
      'error.session-file-not-found': 'Session files not found',
      'error.entry-not-found': 'Trash entry not found',
      'error.target-exists': 'A session already occupies the original path',
      'error.restore-partial': 'Some entries could not be restored',
      'error.purge-partial': 'Some entries could not be deleted',
      'error.fetch-unavailable': 'Network access is unavailable',
      'error.request-failed': 'Request failed',
      'error.trash-failed': 'Could not move the session to the trash',
      'error.restore-failed': 'Restore failed',
      'error.purge-failed': 'Delete failed',
    }

    /** Bind a namespace translator and fill `{name}` placeholders. */
    function makeT(bind) {
      return function t(key, vars) {
        let text = ''
        try { text = bind(key) } catch (error) { text = key }
        if (typeof text !== 'string' || text === '') text = key
        if (vars === undefined) return text
        return text.replace(/\{(\w+)\}/g, function (_, name) {
          return vars[name] === undefined ? '' : String(vars[name])
        })
      }
    }

    /**
     * Label for the View options entry. The current hidden count travels in
     * parentheses so the switch also tells you how many rows it would reveal.
     */
    function showHiddenLabelText(t, count) {
      const n = typeof count === 'number' && count > 0 ? count : 0
      return t('viewOptions.showHiddenCount', { n: n })
    }

    /* ------------------------------------------------------------------ *
     * Pure helpers (also exported as `__test` for test/verify.mjs)        *
     * ------------------------------------------------------------------ */
    function asId(value) {
      return typeof value === 'string' && value.length > 0 ? value : null
    }

    /**
     * Normalize one Host state payload. The Host is the only source of truth;
     * anything malformed degrades to "nothing hidden" instead of throwing.
     */
    function normalizeRemoteState(input) {
      const object = (input !== null && typeof input === 'object' && !Array.isArray(input)) ? input : {}
      const hidden = []
      const seen = new Set()
      if (Array.isArray(object.hidden)) {
        for (const value of object.hidden) {
          const id = asId(value)
          if (id === null || seen.has(id)) continue
          seen.add(id)
          hidden.push(id)
        }
      }
      return {
        hidden: hidden,
        showHidden: object.showHidden === true,
        legacyCleanupDone: object.legacyCleanupDone === true,
      }
    }

    /** Include `extra` ids in a view-only archived list, order-stable. */
    function mergeArchived(base, extra) {
      const list = Array.isArray(base) ? base : []
      if (extra === null || extra.length === 0) return list
      const seen = new Set(list)
      let changed = false
      const out = list.slice()
      for (const id of extra) {
        if (typeof id !== 'string' || seen.has(id)) continue
        seen.add(id)
        out.push(id)
        changed = true
      }
      return changed ? out : list
    }

    /**
     * Project the client Workspace snapshot for the sidebar.
     *
     * - `items` loses the hidden workspaces;
     * - the sessions those workspaces account become view-only archived ids,
     *   so the shipped grouping cannot trail them into "Ungrouped";
     * - pins owned by them are dropped (the Host keeps pin and archive sets
     *   mutually exclusive, and these sessions are view-archived here).
     *
     * Returns the untouched snapshot object when nothing is hidden, keeping
     * `useSyncExternalStore` referentially stable.
     */
    function filterProjection(raw, hidden) {
      if (raw === null || typeof raw !== 'object') return raw
      const items = Array.isArray(raw.items) ? raw.items : []
      let hiddenCount = 0
      const hiddenSessionIds = []
      const hiddenSessionSet = new Set()
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue
        if (!hidden.has(item.workspaceId)) continue
        hiddenCount += 1
        if (Array.isArray(item.sessionIds)) {
          for (const sessionId of item.sessionIds) {
            if (typeof sessionId !== 'string' || hiddenSessionSet.has(sessionId)) continue
            hiddenSessionSet.add(sessionId)
            hiddenSessionIds.push(sessionId)
          }
        }
      }
      if (hiddenCount === 0) return raw

      const base = Array.isArray(raw.archivedSessionIds) ? raw.archivedSessionIds : []
      const archivedSessionIds = mergeArchived(base, hiddenSessionIds)
      let pinnedSessionIds = raw.pinnedSessionIds
      if (Array.isArray(pinnedSessionIds)) {
        const kept = pinnedSessionIds.filter(function (id) { return !hiddenSessionSet.has(id) })
        if (kept.length !== pinnedSessionIds.length) pinnedSessionIds = kept
      }
      return {
        ...raw,
        items: items.filter(function (item) {
          return item !== null && typeof item === 'object' && !hidden.has(item.workspaceId)
        }),
        archivedSessionIds: archivedSessionIds,
        pinnedSessionIds: pinnedSessionIds,
      }
    }

    /** Which shipped menu is this? Answers by visible copy, so it is i18n-safe. */
    function menuKindFromText(text) {
      const value = typeof text === 'string' ? text : ''
      const hasAny = function (list) {
        return list.some(function (needle) { return value.includes(needle) })
      }
      if (hasAny(SHIPPED_TEXT.groupBy)) return 'viewOptions'
      if (hasAny(SHIPPED_TEXT.rename) && hasAny(SHIPPED_TEXT.deleteWorkspace)) return 'workspace'
      return null
    }

    /** True when a clicked element sits on the shipped View options trigger. */
    function isViewOptionsTrigger(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return false
      const button = target.closest('button[aria-label]')
      if (button === null) return false
      const label = typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') : null
      if (typeof label !== 'string') return false
      const value = label.trim()
      return SHIPPED_TEXT.viewOptionsAria.some(function (needle) { return value.includes(needle) })
    }

    /** Workspace id carried by the row that contains `target`, or null. */
    function workspaceIdFromTarget(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null
      const row = target.closest(WORKSPACE_ROW_SELECTOR)
      if (row === null || typeof row.getAttribute !== 'function') return null
      const key = row.getAttribute('data-row-key')
      if (typeof key !== 'string' || !key.startsWith('workspace:')) return null
      return asId(key.slice('workspace:'.length))
    }

    /* ------------------------------------------------------------------ *
     * View state store                                                    *
     * ------------------------------------------------------------------ */
    /**
     * The plugin's in-memory view state. NOTHING is persisted in the browser:
     * the Host state file is the single authority (see `installSync`), exactly
     * like the shipped Workspace registry.
     *
     * Local mutations update the projection immediately (optimistic UI) and are
     * forwarded to the Host through the registered mutation sink.
     */
    function createStore(options) {
      const opts = options === undefined ? {} : options
      let hidden = new Set()
      let showHidden = false
      let legacyCleanupDone = false
      let ready = false
      let version = 0
      let snapshot = null
      let sink = null
      const listeners = new Set()

      /** One stable object per version: React's useSyncExternalStore needs it. */
      function makeSnapshot() {
        return {
          hidden: hidden,
          showHidden: showHidden,
          legacyCleanupDone: legacyCleanupDone,
          ready: ready,
          version: version,
        }
      }
      snapshot = makeSnapshot()

      function notify() {
        version += 1
        snapshot = makeSnapshot()
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (error) { /* a subscriber must not break the rest */ }
        }
      }

      function emit(mutation) {
        if (sink === null) return
        try { sink(mutation) } catch (error) { /* the sync bridge reports its own failures */ }
      }

      const store = {
        getState: function () { return snapshot },
        getVersion: function () { return version },
        subscribe: function (listener) {
          if (typeof listener !== 'function') return function () {}
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        isHidden: function (workspaceId) { return hidden.has(workspaceId) },
        hiddenCount: function () { return hidden.size },
        hiddenIds: function () { return Array.from(hidden) },
        /**
         * Apply the Host's authoritative state. Returns whether anything the UI
         * renders changed, so an echo of our own mutation does not repaint.
         */
        applyRemoteState: function (input) {
          const next = normalizeRemoteState(input)
          const nextHidden = new Set(next.hidden)
          let changed = ready !== true
          if (nextHidden.size !== hidden.size) {
            changed = true
          } else {
            for (const id of nextHidden) {
              if (!hidden.has(id)) { changed = true; break }
            }
          }
          if (next.showHidden !== showHidden) changed = true
          if (next.legacyCleanupDone !== legacyCleanupDone) changed = true
          legacyCleanupDone = next.legacyCleanupDone
          hidden = nextHidden
          showHidden = next.showHidden
          ready = true
          if (changed) notify()
          return changed
        },
        /** Record the one-shot legacy cleanup locally (no repaint needed). */
        markLegacyCleanupDone: function () {
          legacyCleanupDone = true
        },
        /** Bridge the Host mutation channel; returns a deregister function. */
        setMutationSink: function (fn) {
          sink = typeof fn === 'function' ? fn : null
          return function () { if (sink === fn) sink = null }
        },
        setHidden: function (workspaceId, next) {
          const id = asId(workspaceId)
          if (id === null) return false
          const already = hidden.has(id)
          let switchCleared = false
          if (next === true) {
            // Hiding always takes effect immediately: leaving the "show hidden"
            // switch on would keep the just-hidden row on screen.
            if (already && showHidden !== true) return false
            hidden.add(id)
            if (showHidden === true) {
              showHidden = false
              switchCleared = true
            }
          } else {
            if (!already) return false
            hidden.delete(id)
            // Nothing left to reveal: drop the switch back to its default.
            if (hidden.size === 0 && showHidden === true) {
              showHidden = false
              switchCleared = true
            }
          }
          notify()
          emit({ type: 'setHidden', workspaceId: id, value: next === true })
          // The Host must learn about the implicit switch reset too, otherwise
          // its state (and every other client) would keep it on.
          if (switchCleared) emit({ type: 'setShowHidden', value: false })
          return true
        },
        toggleHidden: function (workspaceId) {
          const id = asId(workspaceId)
          if (id === null) return false
          return store.setHidden(id, !hidden.has(id))
        },
        setShowHidden: function (next) {
          const value = next === true
          if (showHidden === value) return false
          showHidden = value
          notify()
          emit({ type: 'setShowHidden', value: value })
          return true
        },
        toggleShowHidden: function () { return store.setShowHidden(!(showHidden === true)) },
        /** Drop ids whose workspace no longer exists (called on a ready snapshot). */
        prune: function (validIds) {
          const valid = validIds instanceof Set ? validIds : new Set(Array.isArray(validIds) ? validIds : [])
          let changed = false
          for (const id of Array.from(hidden)) {
            if (valid.has(id)) continue
            hidden.delete(id)
            changed = true
            emit({ type: 'setHidden', workspaceId: id, value: false })
          }
          if (changed) notify()
          return changed
        },
        dispose: function () {
          listeners.clear()
          sink = null
        },
      }
      return store
    }

    /* ------------------------------------------------------------------ *
     * Host bridge: one GET at boot, SSE afterwards, increments on change  *
     * ------------------------------------------------------------------ */
    /**
     * The browser keeps no copy of the state. At boot the authoritative state
     * is fetched once, then every change arrives through the SSE stream; local
     * mutations are sent as increments so two clients cannot overwrite each
     * other. This mirrors the shipped `workspace/follow` model.
     */
    function installSync(ctx, store, options) {
      const opts = options === undefined ? {} : options
      const warn = typeof opts.warn === 'function' ? opts.warn : function () {}
      const win = typeof window === 'undefined' ? null : window
      const fetchFn = (win !== null && typeof win.fetch === 'function')
        ? win.fetch.bind(win)
        : (typeof fetch === 'function' ? fetch : null)
      let disposed = false
      let source = null
      let retryTimer = null
      let queue = []
      let sending = false
      let booted = false

      if (fetchFn === null) {
        warn('fetch 不可用，隐藏状态无法同步 / fetch unavailable; state stays in memory')
        return function () {}
      }

      async function requestJson(url, init) {
        const response = await fetchFn(url, {
          credentials: 'same-origin',
          cache: 'no-store',
          ...(init === undefined ? {} : init),
        })
        if (!response || response.ok !== true) {
          throw new Error('HTTP ' + (response ? response.status : 'failure'))
        }
        return await response.json()
      }

      function scheduleRetry() {
        if (disposed || retryTimer !== null) return
        retryTimer = setTimeout(function () {
          retryTimer = null
          flush()
        }, 4000)
      }

      async function flush() {
        if (disposed || sending || queue.length === 0) return
        sending = true
        const batch = queue
        queue = []
        try {
          let latest = null
          for (const mutation of batch) {
            latest = await requestJson(MUTATE_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(mutation),
            })
          }
          if (latest !== null) store.applyRemoteState(latest)
        } catch (error) {
          queue = batch.concat(queue)
          if (queue.length > 64) queue.splice(0, queue.length - 64)
          warn('同步到 Host 失败，稍后重试 / failed to sync to the Host: ' + String((error && error.message) || error))
          scheduleRetry()
        } finally {
          sending = false
        }
        if (!disposed && queue.length > 0) flush()
      }

      function enqueue(mutation) {
        if (disposed) return
        queue.push(mutation)
        if (queue.length > 64) queue.splice(0, queue.length - 64)
        flush()
      }

      function removeLegacyKey() {
        try {
          if (win !== null && win.localStorage !== undefined) {
            win.localStorage.removeItem(LEGACY_STORAGE_KEY)
          }
        } catch (error) { /* private mode / storage disabled */ }
      }

      function connectStream() {
        if (disposed) return
        const Ctor = (win !== null && typeof win.EventSource === 'function') ? win.EventSource : null
        if (Ctor === null) {
          warn('EventSource 不可用，多客户端同步暂停 / EventSource unavailable; live sync is off')
          return
        }
        try {
          source = new Ctor(STREAM_URL)
        } catch (error) {
          source = null
          return
        }
        source.onmessage = function (event) {
          if (disposed || typeof event.data !== 'string') return
          let state = null
          try { state = JSON.parse(event.data) } catch (error) { return }
          store.applyRemoteState(state)
        }
        source.onerror = function () { /* EventSource reconnects by itself */ }
      }

      async function bootstrap() {
        try {
          const state = await requestJson(STATE_URL)
          if (disposed) return
          // One-shot legacy cleanup, recorded on the Host so later starts skip
          // it entirely (the browser is not touched again afterwards).
          if (state !== null && typeof state === 'object' && state.legacyCleanupDone !== true) {
            removeLegacyKey()
            enqueue({ type: 'setLegacyCleanupDone', value: true })
          }
          store.applyRemoteState(state)
          booted = true
          connectStream()
        } catch (error) {
          if (disposed) return
          warn('无法读取 Host 状态，稍后重试 / cannot read the Host state: ' + String((error && error.message) || error))
          if (retryTimer === null) {
            retryTimer = setTimeout(function () {
              retryTimer = null
              if (!disposed && !booted) bootstrap()
            }, 5000)
          }
        }
      }

      const offSink = store.setMutationSink(enqueue)
      bootstrap()

      return function dispose() {
        disposed = true
        if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
        offSink()
        try { if (source !== null) source.close() } catch (error) { /* ignore */ }
      }
    }

    /* ------------------------------------------------------------------ *
     * Data layer: wrap the client Workspace model                        *
     * ------------------------------------------------------------------ */
    /**
     * Replace `getSnapshot`/`subscribe` on `workspaces.list` with a filtering
     * projection. The shipped sidebar calls both lazily on that same model
     * instance, so the whole browsing surface (rows, search, the Hero picker)
     * reads the projection. A disposer restores the original own-property shape.
     */
    function installWorkspaceProjection(ctx, store, options) {
      const opts = options === undefined ? {} : options
      const warn = typeof opts.warn === 'function' ? opts.warn : function () {}
      let service = null
      try { service = typeof ctx.get === 'function' ? ctx.get('workspaces') : null } catch (error) { service = null }
      const model = service !== null && service !== undefined ? service.list : null
      if (model === null || model === undefined
        || typeof model.getSnapshot !== 'function' || typeof model.subscribe !== 'function') {
        warn('workspaces.list 不可用，隐藏功能未启用 / workspaces.list unavailable; hide is disabled')
        return function () {}
      }
      if (model[INSTALL_MARK] === true) {
        warn('workspaces.list 已被其它插件包装，跳过 / workspaces.list is already wrapped; skipped')
        return function () {}
      }

      const originalGetSnapshot = model.getSnapshot
      const originalSubscribe = model.subscribe
      const ownGetSnapshot = Object.getOwnPropertyDescriptor(model, 'getSnapshot')
      const ownSubscribe = Object.getOwnPropertyDescriptor(model, 'subscribe')

      let cacheRaw = null
      let cacheVersion = -1
      let cacheOut = null
      let pruneScheduled = false

      function schedulePrune(raw) {
        // Only prune on a settled baseline; an empty loading snapshot must not
        // be mistaken for "every hidden workspace was deleted".
        if (raw === null || typeof raw !== 'object' || raw.state !== 'ready') return
        if (pruneScheduled) return
        pruneScheduled = true
        const run = function () {
          pruneScheduled = false
          const current = raw
          if (current === null || typeof current !== 'object') return
          const valid = new Set()
          const items = Array.isArray(current.items) ? current.items : []
          for (const item of items) {
            if (item !== null && typeof item === 'object') valid.add(item.workspaceId)
          }
          store.prune(valid)
        }
        if (typeof setTimeout === 'function') setTimeout(run, 0)
        else run()
      }

      const wrappedGetSnapshot = function () {
        const raw = originalGetSnapshot.call(model)
        schedulePrune(raw)
        const state = store.getState()
        if (state.hidden.size === 0 || state.showHidden === true) {
          cacheRaw = raw
          cacheVersion = state.version
          cacheOut = raw
          return raw
        }
        if (cacheRaw === raw && cacheVersion === state.version) return cacheOut
        const out = filterProjection(raw, state.hidden)
        cacheRaw = raw
        cacheVersion = state.version
        cacheOut = out
        return out
      }

      const wrappedSubscribe = function (listener) {
        const offModel = originalSubscribe.call(model, listener)
        const offStore = store.subscribe(listener)
        return function () {
          if (typeof offModel === 'function') {
            try { offModel() } catch (error) { /* ignore */ }
          }
          offStore()
        }
      }

      try {
        model.getSnapshot = wrappedGetSnapshot
        model.subscribe = wrappedSubscribe
      } catch (error) {
        warn('包装 workspaces.list 失败：' + String(error) + ' / cannot wrap workspaces.list')
        return function () {}
      }
      if (model.getSnapshot !== wrappedGetSnapshot || model.subscribe !== wrappedSubscribe) {
        warn('workspaces.list 属性只读，隐藏功能未启用 / workspaces.list properties are read-only')
        return function () {}
      }
      try { Object.defineProperty(model, INSTALL_MARK, { value: true, configurable: true }) } catch (error) { /* marker optional */ }

      return function dispose() {
        try {
          if (model.getSnapshot === wrappedGetSnapshot) {
            if (ownGetSnapshot !== undefined) Object.defineProperty(model, 'getSnapshot', ownGetSnapshot)
            else delete model.getSnapshot
          }
          if (model.subscribe === wrappedSubscribe) {
            if (ownSubscribe !== undefined) Object.defineProperty(model, 'subscribe', ownSubscribe)
            else delete model.subscribe
          }
          if (model[INSTALL_MARK] === true) delete model[INSTALL_MARK]
        } catch (error) { /* best effort */ }
        cacheRaw = null
        cacheOut = null
      }
    }

    /* ------------------------------------------------------------------ *
     * DOM layer: menu entries, row marker, styles                         *
     * ------------------------------------------------------------------ */
    const CSS = `
.dsh-enh-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;font-family:inherit}
.dsh-enh-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-enh-menu-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#888)}
.dsh-enh-menu-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[${ROW_FLAG}]{opacity:.55}
[${ROW_FLAG}] [class*="title"]{font-style:italic}
.dsh-enh-foot{display:inline-flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;height:28px;min-width:28px;padding:0 6px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#888);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dsh-enh-foot:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-enh-foot[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-enh-foot svg{display:block;flex:none}
.dsh-enh-foot-count{font-variant-numeric:tabular-nums}
.dsh-enh-trash-panel{display:flex;flex-direction:column;gap:12px;padding:4px 0 24px;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.dsh-enh-trash-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-enh-trash-head-title{font-size:14px;font-weight:600}
.dsh-enh-trash-hint{flex:1;min-width:0;color:var(--dsw-alias-label-secondary,#888);font-size:12px}
.dsh-enh-trash-actions{display:flex;align-items:center;gap:8px}
.dsh-enh-trash-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.18))}
.dsh-enh-trash-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dsh-enh-trash-check{flex:none;width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}
.dsh-enh-trash-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-enh-trash-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-enh-trash-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,#888);font-size:12px}
.dsh-enh-trash-ws{display:inline-flex;align-items:center;gap:4px}
.dsh-enh-trash-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#888);font-size:13px}
.dsh-enh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.28));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dsh-enh-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-enh-btn:disabled{opacity:.45;cursor:default}
.dsh-enh-btn[aria-disabled="true"]{opacity:.45;cursor:default}
.dsh-enh-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff}
.dsh-enh-btn-primary:hover{filter:brightness(1.06);background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-enh-btn-danger{border-color:rgba(229,72,77,.45);color:#e5484d}
.dsh-enh-btn-danger:hover{background:rgba(229,72,77,.1)}
.dsh-enh-trash-foot{display:flex;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--dsw-alias-border-default,rgba(127,127,127,.15))}
.dsh-enh-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42);pointer-events:auto}
.dsh-enh-dialog{width:440px;max-width:100%;box-sizing:border-box;padding:20px;border-radius:12px;background:var(--dsw-alias-bg-elevated,#20242b);color:var(--dsw-alias-label-primary,#f2f3f5);box-shadow:0 18px 48px rgba(0,0,0,.35);font-size:13px;line-height:1.6}
.dsh-enh-dialog-title{font-size:15px;font-weight:600;margin-bottom:10px}
.dsh-enh-dialog-body{color:var(--dsw-alias-label-secondary,#b9bdc4)}
.dsh-enh-dialog-body strong{color:var(--dsw-alias-label-primary,#f2f3f5);font-weight:600}
.dsh-enh-dialog-error{margin-top:10px;padding:8px 10px;border-radius:6px;background:rgba(229,72,77,.12);color:#e5484d;font-size:12px}
.dsh-enh-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap}
.dsh-enh-dialog-note{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#8f949c)}
.dsh-enh-footer-button{position:relative;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:28px;height:28px;min-width:28px;padding:0;margin:0;align-self:center;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#888);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dsh-enh-footer-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-enh-footer-button[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-enh-footer-badge{position:absolute;top:-1px;right:-3px;min-width:13px;height:13px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-size:9px;line-height:13px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none}
.dsh-enh-trash-modal{width:680px;max-width:calc(100vw - 48px);max-height:calc(100vh - 96px);display:flex;flex-direction:column}
.dsh-enh-trash-modal .dsh-enh-trash-panel{overflow:auto;min-height:0}
.dsh-enh-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.dsh-enh-icon-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#8f949c);cursor:pointer;font-size:16px;line-height:1}
.dsh-enh-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:inherit}
`

    const TRASH_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.2"><path d="M2.8 4.2h10.4M6.3 2.5h3.4M4.2 4.2l.6 8.2c.05.6.55 1.1 1.15 1.1h4.1c.6 0 1.1-.5 1.15-1.1l.6-8.2"/><path d="M6.6 6.6v4.2M9.4 6.6v4.2"/></svg>'

    function installStyles(doc) {
      if (doc === null || doc === undefined || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') {
        return function () {}
      }
      if (doc.getElementById(STYLE_ID) !== null) return function () {}
      const style = doc.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      const parent = doc.head !== null && doc.head !== undefined ? doc.head : doc.documentElement
      if (parent !== null && parent !== undefined && typeof parent.appendChild === 'function') parent.appendChild(style)
      return function () {
        const existing = doc.getElementById(STYLE_ID)
        if (existing !== null && typeof existing.remove === 'function') existing.remove()
      }
    }

    /** Close the shipped menu the way its own keyboard handling does. */
    function closeShippedMenu(doc, win) {
      try {
        const target = (doc.activeElement !== null && doc.activeElement !== undefined)
          ? doc.activeElement
          : (doc.body !== null && doc.body !== undefined ? doc.body : doc.documentElement)
        if (target === null || target === undefined || typeof target.dispatchEvent !== 'function') return
        const KeyboardEventCtor = (win !== null && win !== undefined && typeof win.KeyboardEvent === 'function')
          ? win.KeyboardEvent
          : (typeof KeyboardEvent === 'function' ? KeyboardEvent : null)
        if (KeyboardEventCtor === null) return
        target.dispatchEvent(new KeyboardEventCtor('keydown', {
          key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
        }))
      } catch (error) { /* the menu closes on the next outside click anyway */ }
    }

    /** Copy one shipped menu item's wrapper + item classes. */
    function createMenuItem(doc, menu) {
      const sampleItem = menu.querySelector(MENU_ITEM_SELECTOR)
      const sampleWrap = sampleItem !== null && sampleItem.parentElement !== null ? sampleItem.parentElement : null
      const wrap = doc.createElement('div')
      if (sampleWrap !== null && typeof sampleWrap.className === 'string' && sampleWrap.className !== '') {
        wrap.className = sampleWrap.className
      }
      const button = doc.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.className = (sampleItem !== null && typeof sampleItem.className === 'string' && sampleItem.className !== '')
        ? sampleItem.className
        : 'dsh-enh-menu-item'
      const icon = doc.createElement('span')
      icon.className = 'dsh-enh-menu-icon'
      if (sampleItem !== null) {
        const sampleIcon = sampleItem.querySelector('span')
        if (sampleIcon !== null && typeof sampleIcon.className === 'string' && sampleIcon.className !== '') {
          icon.className = sampleIcon.className
        }
      }
      const label = doc.createElement('span')
      label.className = 'dsh-enh-menu-label'
      if (sampleItem !== null) {
        const sampleLabel = sampleItem.querySelector('span:last-child')
        if (sampleLabel !== null && typeof sampleLabel.className === 'string' && sampleLabel.className !== '') {
          label.className = sampleLabel.className
        }
      }
      button.appendChild(icon)
      button.appendChild(label)
      wrap.appendChild(button)
      wrap.setAttribute(MENU_FLAG, '')
      return { wrap: wrap, button: button, icon: icon, label: label }
    }

    function setSvg(element, svg) {
      if (element === null || element === undefined) return
      if (typeof element.innerHTML === 'string') element.innerHTML = svg
    }

    /**
     * Wire the two shipped menus plus the hidden-row marker.
     *
     * A click captures which row (or the View options trigger) armed the next
     * menu; a MutationObserver scans for the menu's portal and appends the
     * matching entries. Every entry clones the shipped item's classes. The
     * entries live outside the menu's React tree, so each one closes the menu
     * with the same Escape keydown a keyboard user sends.
     */
    function installDomBridge(doc, win, store, bindLocale, options) {
      const opts = options === undefined ? {} : options
      const warn = typeof opts.warn === 'function' ? opts.warn : function () {}
      if (doc === null || doc === undefined || typeof doc.addEventListener !== 'function'
        || typeof doc.querySelectorAll !== 'function' || doc.body === null || doc.body === undefined) {
        return function () {}
      }
      /** Re-bind on every injection so a locale switch also changes the copies. */
      function translate() {
        return typeof bindLocale === 'function' ? makeT(bindLocale()) : makeT(function (key) { return key })
      }
      const fetchFn = (win !== null && win !== undefined && typeof win.fetch === 'function')
        ? win.fetch.bind(win)
        : (typeof fetch === 'function' ? fetch : null)
      let armed = null
      let scanScheduled = false
      let disposed = false
      let labelResetTimer = null
      const disposers = []

      function now() { return Date.now() }

      function arm(kind, workspaceId) {
        armed = { kind: kind, workspaceId: workspaceId === undefined ? null : workspaceId, until: now() + ARM_TTL_MS }
      }

      function onPointerDownCapture(event) {
        if (disposed) return
        const target = event !== null && event !== undefined ? event.target : null
        const viewOptions = isViewOptionsTrigger(target)
        if (viewOptions) { arm('viewOptions'); return }
        const workspaceId = workspaceIdFromTarget(target)
        if (workspaceId !== null) arm('workspace', workspaceId)
      }

      function onKeyDownCapture(event) {
        if (disposed) return
        const key = event !== null && event !== undefined ? event.key : null
        if (key !== 'Enter' && key !== ' ') return
        onPointerDownCapture(event)
      }

      function scheduleScan() {
        if (disposed || scanScheduled) return
        scanScheduled = true
        const run = function () {
          scanScheduled = false
          if (!disposed) scan()
        }
        if (typeof setTimeout === 'function') setTimeout(run, 0)
        else run()
      }

      function scan() {
        if (armed !== null && now() > armed.until) armed = null
        const menus = Array.from(doc.querySelectorAll(MENU_SELECTOR))
        for (const menu of menus) {
          if (menu.querySelector('[' + MENU_FLAG + ']') !== null) {
            refreshInjectedEntries(menu)
            continue
          }
          const kind = menuKindFromText(typeof menu.textContent === 'string' ? menu.textContent : '')
          if (kind === null) continue
          if (armed === null || armed.kind !== kind) continue
          if (kind === 'workspace') {
            if (armed.workspaceId === null) continue
            injectWorkspaceEntry(menu, armed.workspaceId)
            armed = null
          } else {
            injectViewOptionsEntry(menu)
            armed = null
          }
        }
        markHiddenRows()
      }

      function labelForWorkspace(workspaceId) {
        return translate()(store.isHidden(workspaceId) ? 'menu.unhide' : 'menu.hide')
      }

      function labelForViewOptions() {
        return showHiddenLabelText(translate(), store.hiddenCount())
      }

      /** Keep an already-injected entry current while its menu stays open. */
      function refreshInjectedEntries(menu) {
        const t = translate()
        const wraps = Array.from(menu.querySelectorAll('[' + MENU_FLAG + ']'))
        for (const wrap of wraps) {
          const label = wrap.dshEnhLabel
          const button = wrap.querySelector('button')
          if (label === undefined || label === null) continue
          const kind = typeof wrap.getAttribute === 'function' ? wrap.getAttribute('data-dsh-enh-kind') : null
          if (kind === 'viewOptions') {
            label.textContent = labelForViewOptions()
            if (button !== null && typeof button.setAttribute === 'function') {
              button.setAttribute('aria-checked', store.getState().showHidden === true ? 'true' : 'false')
            }
          } else if (kind === 'hide') {
            const id = typeof wrap.getAttribute === 'function' ? wrap.getAttribute('data-dsh-enh-workspace') : null
            if (id !== null && id !== undefined) label.textContent = labelForWorkspace(id)
          } else if (kind === 'open') {
            // A transient failure copy must survive a state repaint.
            if (wrap.dshEnhError !== true) label.textContent = t('menu.openFolder')
          }
        }
      }

      /**
       * Append both workspace-row entries. "Open folder" comes first because it
       * is the everyday action; "Hide workspace" keeps its toggle copy.
       */
      function injectWorkspaceEntry(menu, workspaceId) {
        const viewport = menu.querySelector(MENU_VIEWPORT_SELECTOR)
        const parent = viewport !== null ? viewport : menu
        parent.appendChild(createOpenFolderEntry(menu, workspaceId))
        parent.appendChild(createHideEntry(menu, workspaceId))
      }

      function createOpenFolderEntry(menu, workspaceId) {
        const parts = createMenuItem(doc, menu)
        parts.wrap.setAttribute('data-dsh-enh-kind', 'open')
        parts.wrap.setAttribute('data-dsh-enh-workspace', workspaceId)
        parts.wrap.dshEnhLabel = parts.label
        parts.label.textContent = translate()('menu.openFolder')
        setSvg(parts.icon, FOLDER_SVG)
        parts.button.addEventListener('click', function (event) {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
          if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
          openWorkspaceFolder(workspaceId, parts)
        })
        return parts.wrap
      }

      function createHideEntry(menu, workspaceId) {
        const parts = createMenuItem(doc, menu)
        const action = function (event) {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
          if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
          store.setHidden(workspaceId, !store.isHidden(workspaceId))
          closeShippedMenu(doc, win)
        }
        parts.button.addEventListener('click', action)
        parts.wrap.setAttribute('data-dsh-enh-kind', 'hide')
        parts.wrap.setAttribute('data-dsh-enh-workspace', workspaceId)
        parts.wrap.dshEnhLabel = parts.label
        parts.label.textContent = labelForWorkspace(workspaceId)
        setSvg(parts.icon, EYE_SVG)
        return parts.wrap
      }

      /**
       * Ask the Host to open this workspace's directory.
       *
       * The path never travels through the page: the Host resolves it from the
       * workspace registry, so a stale row can never open an arbitrary folder.
       * On failure the menu stays open and the label reports why — a silently
       * dismissed menu would look like nothing happened.
       */
      function openWorkspaceFolder(workspaceId, parts) {
        if (typeof fetchFn !== 'function') {
          showTemporaryLabel(parts, translate()('menu.openFolderFailed'))
          return
        }
        let request
        try {
          request = fetchFn(OPEN_URL, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: workspaceId }),
          })
        } catch (error) {
          showTemporaryLabel(parts, translate()('menu.openFolderFailed'))
          return
        }
        Promise.resolve(request).then(function (response) {
          return response.json().then(function (payload) {
            return { ok: response.ok === true, payload: payload }
          }, function () { return { ok: false, payload: null } })
        }).then(function (result) {
          if (disposed) return
          const payload = (result.payload !== null && typeof result.payload === 'object') ? result.payload : {}
          if (result.ok === true && payload.ok === true) {
            closeShippedMenu(doc, win)
            return
          }
          showTemporaryLabel(parts, payload.error === 'missing-dir'
            ? translate()('menu.openFolderMissing')
            : translate()('menu.openFolderFailed'))
        }, function () {
          if (!disposed) showTemporaryLabel(parts, translate()('menu.openFolderFailed'))
        })
      }

      /** Show a transient failure copy, then fall back to the normal label. */
      function showTemporaryLabel(parts, text) {
        if (parts === null || parts === undefined || parts.label === null || parts.label === undefined) return
        parts.wrap.dshEnhError = true
        parts.label.textContent = text
        if (labelResetTimer !== null) clearTimeout(labelResetTimer)
        labelResetTimer = setTimeout(function () {
          labelResetTimer = null
          if (disposed) return
          parts.wrap.dshEnhError = false
          if (parts.label !== null && parts.label !== undefined) {
            parts.label.textContent = translate()('menu.openFolder')
          }
        }, 2400)
      }

      function injectViewOptionsEntry(menu) {
        const parts = createMenuItem(doc, menu)
        const on = store.getState().showHidden === true
        const action = function (event) {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
          if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
          store.setShowHidden(!(store.getState().showHidden === true))
          closeShippedMenu(doc, win)
        }
        parts.button.addEventListener('click', action)
        parts.wrap.setAttribute('data-dsh-enh-kind', 'viewOptions')
        parts.wrap.dshWvLabel = parts.label
        parts.button.setAttribute('aria-checked', on ? 'true' : 'false')
        parts.label.textContent = labelForViewOptions()
        setSvg(parts.icon, on ? CHECK_SVG : EYE_SVG)
        const viewport = menu.querySelector(MENU_VIEWPORT_SELECTOR)
        ;(viewport !== null ? viewport : menu).appendChild(parts.wrap)
      }

      function markHiddenRows() {
        const state = store.getState()
        const rows = Array.from(doc.querySelectorAll(WORKSPACE_ROW_SELECTOR))
        for (const row of rows) {
          const key = typeof row.getAttribute === 'function' ? row.getAttribute('data-row-key') : null
          const id = typeof key === 'string' && key.startsWith('workspace:') ? key.slice('workspace:'.length) : ''
          const shouldMark = id !== '' && state.hidden.has(id)
          if (shouldMark) {
            if (typeof row.setAttribute === 'function') row.setAttribute(ROW_FLAG, '')
          } else if (typeof row.removeAttribute === 'function') {
            row.removeAttribute(ROW_FLAG)
          }
        }
      }

      doc.addEventListener('pointerdown', onPointerDownCapture, true)
      doc.addEventListener('click', onPointerDownCapture, true)
      doc.addEventListener('keydown', onKeyDownCapture, true)
      disposers.push(function () {
        doc.removeEventListener('pointerdown', onPointerDownCapture, true)
        doc.removeEventListener('click', onPointerDownCapture, true)
        doc.removeEventListener('keydown', onKeyDownCapture, true)
      })

      const MutationObserverCtor = (win !== null && win !== undefined && typeof win.MutationObserver === 'function')
        ? win.MutationObserver
        : (typeof MutationObserver === 'function' ? MutationObserver : null)
      let observer = null
      if (MutationObserverCtor !== null && doc.body !== null && doc.body !== undefined) {
        observer = new MutationObserverCtor(scheduleScan)
        try { observer.observe(doc.body, { childList: true, subtree: true }) } catch (error) { observer = null }
        if (observer !== null) {
          disposers.push(function () {
            try { observer.disconnect() } catch (error) { /* already gone */ }
          })
        }
      } else {
        warn('MutationObserver 不可用，菜单入口不会出现 / MutationObserver unavailable; menu entries are off')
      }

      const offStore = store.subscribe(function () { scheduleScan() })
      disposers.push(offStore)
      scheduleScan()

      return function dispose() {
        disposed = true
        if (labelResetTimer !== null) {
          clearTimeout(labelResetTimer)
          labelResetTimer = null
        }
        for (const fn of disposers) {
          try { fn() } catch (error) { /* ignore */ }
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * Session list projection: hide trashed sessions                      *
     *                                                                     *
     * The sidebar's rows come from the `sessions.list` model, which is a  *
     * different data source than the workspace registry. `detachSession`  *
     * only re-groups those rows; it does NOT reload the session list, so  *
     * a trashed session would stay visible with no group and land in      *
     * "Ungrouped". Wrapping this model is what actually removes it from   *
     * every surface (rows, ungrouped bucket, recents, search hints).      *
     * ------------------------------------------------------------------ */
    function installTrashProjection(ctx, trashStore, options) {
      const opts = options === undefined ? {} : options
      const warn = typeof opts.warn === 'function' ? opts.warn : function () {}
      let service = null
      try { service = typeof ctx.get === 'function' ? ctx.get('sessions') : null } catch (error) { service = null }
      const model = service !== null && service !== undefined ? service.list : null
      if (model === null || model === undefined
        || typeof model.getSnapshot !== 'function' || typeof model.subscribe !== 'function') {
        warn('sessions.list 不可用，已删除会话的过滤未启用 / sessions.list unavailable; trash filtering is off')
        return function () {}
      }
      if (model[TRASH_PROJECTION_MARK] === true) {
        warn('sessions.list 已被其它实例包装，跳过 / sessions.list is already wrapped; skipped')
        return function () {}
      }
      const originalGetSnapshot = model.getSnapshot
      const originalSubscribe = model.subscribe
      const ownGetSnapshot = Object.getOwnPropertyDescriptor(model, 'getSnapshot')
      const ownSubscribe = Object.getOwnPropertyDescriptor(model, 'subscribe')
      let cacheRaw = null
      let cacheSignature = null
      let cacheOut = null

      /** Cheap change key: the set of trashed session ids. */
      function signature() {
        const entries = trashStore.getSnapshot().entries
        if (!Array.isArray(entries) || entries.length === 0) return ''
        return entries.map(function (entry) { return entry.sessionId }).sort().join('\u0000')
      }

      function deletedSet() {
        const set = new Set()
        const entries = trashStore.getSnapshot().entries
        if (!Array.isArray(entries)) return set
        for (const entry of entries) {
          if (entry !== null && entry !== undefined && typeof entry.sessionId === 'string') set.add(entry.sessionId)
        }
        return set
      }

      const wrappedGetSnapshot = function () {
        const raw = originalGetSnapshot.call(model)
        const sig = signature()
        if (sig === '') return raw
        if (cacheRaw === raw && cacheSignature === sig) return cacheOut
        if (raw === null || typeof raw !== 'object') return raw
        const deleted = deletedSet()
        let ids = raw.ids
        if (Array.isArray(ids)) {
          const kept = ids.filter(function (id) { return !deleted.has(id) })
          if (kept.length !== ids.length) ids = kept
        }
        let byId = raw.byId
        if (byId !== null && typeof byId === 'object') {
          let changed = false
          const next = {}
          for (const key of Object.keys(byId)) {
            if (deleted.has(key)) changed = true
            else next[key] = byId[key]
          }
          if (changed) byId = next
        }
        cacheRaw = raw
        cacheSignature = sig
        cacheOut = Object.assign({}, raw, { ids: ids, byId: byId })
        return cacheOut
      }

      const wrappedSubscribe = function (listener) {
        const offModel = originalSubscribe.call(model, listener)
        const offStore = trashStore.subscribe(listener)
        return function () {
          if (typeof offModel === 'function') { try { offModel() } catch (error) { /* ignore */ } }
          try { offStore() } catch (error) { /* ignore */ }
        }
      }

      try {
        model.getSnapshot = wrappedGetSnapshot
        model.subscribe = wrappedSubscribe
      } catch (error) {
        warn('包装 sessions.list 失败 / cannot wrap sessions.list')
        return function () {}
      }
      try { Object.defineProperty(model, TRASH_PROJECTION_MARK, { value: true, configurable: true }) } catch (error) { /* marker optional */ }

      return function dispose() {
        try {
          if (model.getSnapshot === wrappedGetSnapshot) {
            if (ownGetSnapshot !== undefined) Object.defineProperty(model, 'getSnapshot', ownGetSnapshot)
            else delete model.getSnapshot
          }
          if (model.subscribe === wrappedSubscribe) {
            if (ownSubscribe !== undefined) Object.defineProperty(model, 'subscribe', ownSubscribe)
            else delete model.subscribe
          }
          if (model[TRASH_PROJECTION_MARK] === true) delete model[TRASH_PROJECTION_MARK]
        } catch (error) { /* best effort */ }
        cacheRaw = null
        cacheSignature = null
        cacheOut = null
      }
    }

    /* ------------------------------------------------------------------ *
     * Session trash UI (slots)                                            *
     *                                                                     *
     * Three surfaces share one observable store: the Session row's "…"    *
     * menu entry, the confirmation overlay, and the Settings → Plugins →  *
     * Trash tab. Every action talks to lib/index.js; the browser never    *
     * touches session files itself.                                       *
     * ------------------------------------------------------------------ */
    const TRASH_URL = API_PREFIX + '/trash'
    const TRASH_INSPECT_URL = TRASH_URL + '/inspect'
    const TRASH_MOVE_URL = TRASH_URL + '/move'
    const TRASH_RESTORE_URL = TRASH_URL + '/restore'
    const TRASH_PURGE_URL = TRASH_URL + '/purge'
    const TRASH_EMPTY_URL = TRASH_URL + '/empty'

    /** Observable state shared by the three slot surfaces. */
    function createTrashStore() {
      let snapshot = {
        /** `null` or `{ type, ... }` — see the dialog component for the shapes. */
        dialog: null,
        /** Sidebar panel visibility (the trash entry beside Settings). */
        panelOpen: false,
        entries: [],
        loading: false,
        error: '',
        selected: [],
        busy: false,
      }
      const listeners = new Set()
      function set(patch) {
        snapshot = Object.assign({}, snapshot, patch)
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (error) { /* a subscriber must not break the rest */ }
        }
      }
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function (listener) {
          if (typeof listener !== 'function') return function () {}
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        set: set,
        dispose: function () { listeners.clear() },
      }
    }

    /** One JSON round trip with a uniform `{ ok, error }` failure shape. */
    function requestTrashJson(url, init) {
      const fetchFn = (typeof window !== 'undefined' && typeof window.fetch === 'function')
        ? window.fetch.bind(window)
        : (typeof fetch === 'function' ? fetch : null)
      if (fetchFn === null) return Promise.reject(new Error('fetch-unavailable'))
      const options = Object.assign({ credentials: 'same-origin', cache: 'no-store' }, init === undefined ? {} : init)
      return fetchFn(url, options).then(function (response) {
        return response.json().then(function (payload) {
          return { ok: response.ok === true, payload: payload }
        }, function () { return { ok: false, payload: null } })
      }).then(function (result) {
        if (result.ok !== true || result.payload === null || result.payload.ok !== true) {
          const code = (result.payload !== null && typeof result.payload.error === 'string')
            ? result.payload.error
            : 'request-failed'
          const error = new Error(code)
          error.code = code
          throw error
        }
        return result.payload
      })
    }

    /** Locale-aware "3 minutes ago". */
    function relativeTimeText(t, iso) {
      const then = Date.parse(String(iso))
      if (!Number.isFinite(then)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
      if (seconds < 60) return t('time.justNow')
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return t('time.minutesAgo', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('time.hoursAgo', { n: hours })
      return t('time.daysAgo', { n: Math.floor(hours / 24) })
    }

    /** Human byte size for one trash entry. */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
      return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    }

    /**
     * All user actions in one object; the slot components receive it through
     * their `inject` props and never call `fetch` themselves.
     */
    function createTrashController(store, bindLocale) {
      function t() {
        return typeof bindLocale === 'function' ? makeT(bindLocale()) : makeT(function (key) { return key })
      }
      function dialog() { return store.getSnapshot().dialog }
      function setDialog(next) { store.set({ dialog: next }) }
      function patchDialog(patch) {
        const current = dialog()
        if (current === null) return
        setDialog(Object.assign({}, current, patch))
      }

      const ui = {
        store: store,
        /** Ask the Host what deleting this session would involve, then open the dialog. */
        beginDelete: function (sessionId, displayTitle) {
          setDialog({
            type: 'trash',
            sessionId: sessionId,
            displayTitle: typeof displayTitle === 'string' ? displayTitle : '',
            inspect: null,
            loading: true,
            error: '',
            busy: false,
          })
          requestTrashJson(TRASH_INSPECT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId }),
          }).then(function (payload) {
            patchDialog({ inspect: payload, loading: false })
          }).catch(function (error) {
            patchDialog({ loading: false, error: (error && error.code) || 'request-failed' })
          })
        },
        closeDialog: function () { setDialog(null) },
        /** Sidebar footer entry: open/close the trash panel. */
        togglePanel: function () {
          const open = store.getSnapshot().panelOpen === true
          store.set({ panelOpen: open !== true })
          if (open !== true) ui.loadTrash()
        },
        closePanel: function () { store.set({ panelOpen: false }) },
        confirmDelete: function (includeChildren) {
          const current = dialog()
          if (current === null || current.busy === true) return
          patchDialog({ busy: true, error: '' })
          requestTrashJson(TRASH_MOVE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: current.sessionId,
              includeChildren: includeChildren === true,
              displayTitle: current.displayTitle,
            }),
          }).then(function () {
            setDialog(null)
            // Reloading the trash list updates the shared store; the
            // `sessions.list` projection is subscribed to it, so the row
            // disappears from every surface without a page reload.
            ui.loadTrash()
          }).catch(function (error) {
            patchDialog({ busy: false, error: (error && error.code) || 'trash-failed' })
          })
        },
        loadTrash: function () {
          const token = (ui._token || 0) + 1
          ui._token = token
          store.set({ loading: true, error: '' })
          requestTrashJson(TRASH_URL, { method: 'GET' }).then(function (payload) {
            if (ui._token !== token) return
            const entries = Array.isArray(payload.entries) ? payload.entries : []
            store.set({ entries: entries, loading: false, error: '' })
          }).catch(function (error) {
            if (ui._token !== token) return
            store.set({ loading: false, error: (error && error.code) || 'request-failed' })
          })
        },
        toggleSelect: function (entryId) {
          const state = store.getSnapshot()
          const selected = state.selected.slice()
          const index = selected.indexOf(entryId)
          if (index >= 0) selected.splice(index, 1)
          else selected.push(entryId)
          store.set({ selected: selected })
        },
        selectAll: function (entryIds) {
          const state = store.getSnapshot()
          const all = Array.isArray(entryIds) ? entryIds : []
          const hasAll = all.length > 0 && all.every(function (id) { return state.selected.indexOf(id) >= 0 })
          store.set({ selected: hasAll ? [] : all })
        },
        restoreSelected: function () {
          const state = store.getSnapshot()
          if (state.selected.length === 0 || state.busy === true) return
          store.set({ busy: true, error: '' })
          requestTrashJson(TRASH_RESTORE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entryIds: state.selected }),
          }).then(function (payload) {
            const failed = Array.isArray(payload.failed) && payload.failed.length > 0
            store.set({ busy: false, selected: [], error: failed ? 'restore-partial' : '' })
            ui.loadTrash()
          }).catch(function (error) {
            store.set({ busy: false, error: (error && error.code) || 'restore-failed' })
          })
        },
        askPurge: function () {
          const state = store.getSnapshot()
          if (state.selected.length === 0) return
          setDialog({ type: 'purge', entryIds: state.selected.slice(), busy: false, error: '' })
        },
        confirmPurge: function () {
          const current = dialog()
          if (current === null || current.busy === true) return
          patchDialog({ busy: true, error: '' })
          requestTrashJson(TRASH_PURGE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entryIds: current.entryIds }),
          }).then(function (payload) {
            const failed = Array.isArray(payload.failed) && payload.failed.length > 0
            setDialog(null)
            store.set({ selected: [], busy: false, error: failed ? 'purge-partial' : '' })
            ui.loadTrash()
          }).catch(function (error) {
            patchDialog({ busy: false, error: (error && error.code) || 'purge-failed' })
          })
        },
        askEmpty: function () {
          const state = store.getSnapshot()
          setDialog({ type: 'empty', count: state.entries.filter(function (entry) { return entry.parentEntryId === undefined || entry.parentEntryId === null }).length, busy: false, error: '' })
        },
        confirmEmpty: function () {
          const current = dialog()
          if (current === null || current.busy === true) return
          patchDialog({ busy: true, error: '' })
          requestTrashJson(TRASH_EMPTY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            .then(function () {
              setDialog(null)
              store.set({ selected: [], busy: false, error: '' })
              ui.loadTrash()
            }).catch(function (error) {
              patchDialog({ busy: false, error: (error && error.code) || 'purge-failed' })
            })
        },
        _token: 0,
      }
      return ui
    }

    /** Subscribe one slot component to the shared trash store. */
    function useTrashState(ui) {
      return useSyncExternalStore(ui.store.subscribe, ui.store.getSnapshot)
    }

    /** The Session row menu entry: "Move to Trash". */
    function TrashMenuItem(props) {
      const ui = props.ui
      const t = props.t
      if (ui === null || ui === undefined) return null
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-enh-menu-item',
        onClick: function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          ui.beginDelete(props.sessionId, props.displayTitle)
          if (typeof props.closeMenu === 'function') props.closeMenu()
        },
      }, h('span', {
        className: 'dsh-enh-menu-icon',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: TRASH_SVG },
      }), h('span', { className: 'dsh-enh-menu-label' }, t('menu.trash')))
    }

    /** One row of the trash list. */
    function TrashRow(props) {
      const entry = props.entry
      const t = props.t
      const children = Array.isArray(entry.children) ? entry.children.length : 0
      return h('label', { className: 'dsh-enh-trash-row', style: { cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          className: 'dsh-enh-trash-check',
          checked: props.selected === true,
          disabled: props.disabled === true,
          onChange: function () { props.onToggle(entry.entryId) },
        }),
        h('div', { className: 'dsh-enh-trash-main' },
          h('div', { className: 'dsh-enh-trash-name' }, entry.title || t('common.untitled')),
          h('div', { className: 'dsh-enh-trash-meta' },
            h('span', { className: 'dsh-enh-trash-ws' }, t('trash.workspace', { name: entry.workspaceTitle || t('common.noWorkspace') })),
            h('span', null, relativeTimeText(t, entry.deletedAt)),
            h('span', null, formatBytes(entry.sizeBytes)),
            children > 0 ? h('span', null, t('trash.childrenCount', { n: children })) : null)))
    }

    /** Settings → Plugins → Trash: multi-select, restore, purge, empty. */
    function TrashPanel(props) {
      const ui = props.ui
      const t = props.t
      const state = useTrashState(ui)
      React.useEffect(function () { ui.loadTrash() }, [])
      const roots = state.entries.filter(function (entry) {
        return entry.parentEntryId === undefined || entry.parentEntryId === null
      })
      const rootIds = roots.map(function (entry) { return entry.entryId })
      const selectedSet = new Set(state.selected)
      const selectedCount = rootIds.filter(function (id) { return selectedSet.has(id) }).length
      const allSelected = rootIds.length > 0 && selectedCount === rootIds.length
      const busy = state.busy === true
      return h('div', { className: 'dsh-enh-trash-panel' },
        h('div', { className: 'dsh-enh-trash-head' },
          h('div', { className: 'dsh-enh-trash-head-title' }, t('trash.title')),
          h('div', { className: 'dsh-enh-trash-hint' }, t('trash.hint')),
          h('div', { className: 'dsh-enh-trash-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-enh-btn',
              disabled: selectedCount === 0 || busy,
              onClick: ui.restoreSelected,
            }, selectedCount > 0 ? t('trash.restoreCount', { n: selectedCount }) : t('trash.restore')),
            h('button', {
              type: 'button',
              className: 'dsh-enh-btn dsh-enh-btn-danger',
              disabled: selectedCount === 0 || busy,
              onClick: ui.askPurge,
            }, selectedCount > 0 ? t('trash.purgeCount', { n: selectedCount }) : t('trash.purge')),
            h('button', {
              type: 'button',
              className: 'dsh-enh-btn',
              disabled: state.loading === true,
              onClick: ui.loadTrash,
            }, t('trash.refresh')))),
        state.error !== '' ? h('div', { className: 'dsh-enh-dialog-error' }, t('error.' + state.error)) : null,
        roots.length === 0
          ? h('div', { className: 'dsh-enh-trash-empty' }, state.loading === true ? t('trash.loading') : t('trash.empty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('label', { className: 'dsh-enh-trash-row', style: { cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                className: 'dsh-enh-trash-check',
                checked: allSelected,
                disabled: busy,
                onChange: function () { ui.selectAll(rootIds) },
              }),
              h('div', { className: 'dsh-enh-trash-main' },
                h('div', { className: 'dsh-enh-trash-name' }, t('trash.selectAll')))),
            roots.map(function (entry) {
              return h(TrashRow, {
                key: entry.entryId,
                entry: entry,
                t: t,
                selected: selectedSet.has(entry.entryId),
                disabled: busy,
                onToggle: ui.toggleSelect,
              })
            })),
        h('div', { className: 'dsh-enh-trash-foot' },
          h('button', {
            type: 'button',
            className: 'dsh-enh-btn dsh-enh-btn-danger',
            disabled: roots.length === 0 || busy,
            onClick: ui.askEmpty,
          }, t('trash.emptyTrash', { n: roots.length }))))
    }

    /** Confirmation overlay for delete / purge / empty. */
    function TrashDialog(props) {
      const ui = props.ui
      const t = props.t
      const state = useTrashState(ui)
      const dialog = state.dialog
      if (dialog === null) return null
      let title = ''
      let body = null
      const actions = []
      if (dialog.type === 'trash') {
        const inspect = dialog.inspect
        const name = dialog.displayTitle || t('common.untitled')
        title = t('dialog.trashTitle')
        if (dialog.loading === true) {
          body = h('div', null, t('dialog.inspecting'))
        } else if (inspect === null || inspect === undefined) {
          body = h('div', null, t('dialog.trashFailedHint'))
        } else if (inspect.running === true) {
          body = h('div', null, t('dialog.running', { name: name }))
          actions.push(h('button', { key: 'close', type: 'button', className: 'dsh-enh-btn', onClick: ui.closeDialog }, t('common.close')))
        } else {
          const children = Array.isArray(inspect.children) ? inspect.children : []
          body = h('div', null,
            h('div', null, t('dialog.trashBody', { name: name })),
            h('div', { className: 'dsh-enh-dialog-note' }, t('dialog.workspace', { name: inspect.workspaceTitle || t('common.noWorkspace') })),
            children.length > 0 ? h('div', { className: 'dsh-enh-dialog-note' }, t('dialog.childrenAsk', { n: children.length })) : null)
          actions.push(h('button', { key: 'cancel', type: 'button', className: 'dsh-enh-btn', disabled: dialog.busy === true, onClick: ui.closeDialog }, t('common.cancel')))
          if (children.length > 0) {
            actions.push(h('button', {
              key: 'parent', type: 'button', className: 'dsh-enh-btn', disabled: dialog.busy === true,
              onClick: function () { ui.confirmDelete(false) },
            }, t('dialog.trashOnlyParent')))
            actions.push(h('button', {
              key: 'cascade', type: 'button', className: 'dsh-enh-btn dsh-enh-btn-danger', disabled: dialog.busy === true,
              onClick: function () { ui.confirmDelete(true) },
            }, t('dialog.trashWithChildren', { n: children.length })))
          } else {
            actions.push(h('button', {
              key: 'confirm', type: 'button', className: 'dsh-enh-btn dsh-enh-btn-danger', disabled: dialog.busy === true,
              onClick: function () { ui.confirmDelete(false) },
            }, t('dialog.trashConfirm')))
          }
        }
      } else if (dialog.type === 'purge') {
        title = t('dialog.purgeTitle')
        body = h('div', null, t('dialog.purgeBody', { n: dialog.entryIds.length }))
        actions.push(h('button', { key: 'cancel', type: 'button', className: 'dsh-enh-btn', disabled: dialog.busy === true, onClick: ui.closeDialog }, t('common.cancel')))
        actions.push(h('button', {
          key: 'confirm', type: 'button', className: 'dsh-enh-btn dsh-enh-btn-danger', disabled: dialog.busy === true,
          onClick: ui.confirmPurge,
        }, t('dialog.purgeConfirm')))
      } else {
        title = t('dialog.emptyTitle')
        body = h('div', null, t('dialog.emptyBody', { n: dialog.count }))
        actions.push(h('button', { key: 'cancel', type: 'button', className: 'dsh-enh-btn', disabled: dialog.busy === true, onClick: ui.closeDialog }, t('common.cancel')))
        actions.push(h('button', {
          key: 'confirm', type: 'button', className: 'dsh-enh-btn dsh-enh-btn-danger', disabled: dialog.busy === true,
          onClick: ui.confirmEmpty,
        }, t('dialog.emptyConfirm')))
      }
      return h('div', {
        className: 'dsh-enh-overlay',
        onClick: function (event) {
          if (event && event.target === event.currentTarget && dialog.busy !== true) ui.closeDialog()
        },
      }, h('div', { className: 'dsh-enh-dialog', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'dsh-enh-dialog-title' }, title),
        h('div', { className: 'dsh-enh-dialog-body' }, body),
        dialog.error !== '' ? h('div', { className: 'dsh-enh-dialog-error' }, t('error.' + dialog.error)) : null,
        h('div', { className: 'dsh-enh-dialog-actions' }, actions)))
    }

    /** Sidebar foot entry beside Settings: opens the trash panel. */
    function TrashSidebarButton(props) {
      const ui = props.ui
      const t = props.t
      const state = useTrashState(ui)
      const count = state.entries.filter(function (entry) {
        return entry.parentEntryId === undefined || entry.parentEntryId === null
      }).length
      return h('button', {
        type: 'button',
        className: 'dsh-enh-footer-button',
        title: t('trash.open'),
        'aria-label': t('trash.open'),
        'aria-pressed': state.panelOpen === true ? 'true' : 'false',
        onClick: function () { ui.togglePanel() },
      },
      h('span', { 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: TRASH_SVG } }),
      count > 0 ? h('span', { className: 'dsh-enh-footer-badge' }, String(count)) : null)
    }

    /** Floating trash panel opened from the sidebar foot entry. */
    function TrashPanelOverlay(props) {
      const ui = props.ui
      const t = props.t
      const state = useTrashState(ui)
      if (state.panelOpen !== true) return null
      return h('div', {
        className: 'dsh-enh-overlay',
        onClick: function (event) {
          if (event && event.target === event.currentTarget) ui.closePanel()
        },
      }, h('div', { className: 'dsh-enh-dialog dsh-enh-trash-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'dsh-enh-dialog-head' },
          h('div', { className: 'dsh-enh-dialog-title' }, t('trash.title')),
          h('button', {
            type: 'button',
            className: 'dsh-enh-icon-button',
            title: t('common.close'),
            'aria-label': t('common.close'),
            onClick: function () { ui.closePanel() },
          }, '×')),
        h(TrashPanel, { ui: ui, t: t })))
    }

    /** Register the slot surfaces; a host without them keeps the rest. */
    function installTrashSlots(ctx, ui, bindLocale, options) {
      const opts = options === undefined ? {} : options
      const warn = typeof opts.warn === 'function' ? opts.warn : function () {}
      let slots = null
      // `slots` is an injected service: the context exposes it as a property,
      // and a Cordis proxy throws when it was not injected, so probe safely.
      try {
        slots = typeof ctx.slots === 'undefined' ? null : ctx.slots
      } catch (error) { slots = null }
      if (slots === null || slots === undefined) {
        try { slots = typeof ctx.get === 'function' ? ctx.get('slots') : null } catch (error) { slots = null }
      }
      if (slots === null || slots === undefined
        || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        warn('slots 不可用，会话回收站 UI 未启用 / slots unavailable; trash UI is off')
        return function () {}
      }
      const translate = function () {
        return typeof bindLocale === 'function' ? makeT(bindLocale()) : makeT(function (key) { return key })
      }
      /** Close the shipped menu the way its own keyboard handling does. */
      function closeMenu() {
        try {
          const doc = typeof document === 'undefined' ? null : document
          if (doc === null) return
          const target = (doc.activeElement !== null && doc.activeElement !== undefined) ? doc.activeElement : doc.body
          if (target === null || target === undefined || typeof target.dispatchEvent !== 'function') return
          const KeyboardEventCtor = (typeof window !== 'undefined' && typeof window.KeyboardEvent === 'function')
            ? window.KeyboardEvent
            : (typeof KeyboardEvent === 'function' ? KeyboardEvent : null)
          if (KeyboardEventCtor === null) return
          target.dispatchEvent(new KeyboardEventCtor('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
          }))
        } catch (error) { /* the menu closes on the next outside click anyway */ }
      }
      const disposers = []
      function register(slotName, registration, Component) {
        const dispose = slots.inject(slotName, function () {
          return slots.register(Object.assign({ name: slotName }, registration), Component)
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      register('sidebar.workspaces.session.menu.item', {
        id: NS + '-trash',
        order: 420,
        label: function () { return translate()('menu.trash') },
        locale: NS,
        inject: function () { return { ui: ui, t: translate(), closeMenu: closeMenu } },
      }, TrashMenuItem)
      register('shell.overlay', {
        id: NS + '-trash-dialog',
        order: 50,
        label: function () { return 'dsh-enhancer' },
        locale: NS,
        inject: function () { return { ui: ui, t: translate() } },
      }, TrashDialog)
      register('settings.plugins.tab', {
        id: NS + '-trash',
        order: 80,
        label: function () { return translate()('trash.tab') },
        locale: NS,
        inject: function () { return { ui: ui, t: translate() } },
      }, TrashPanel)
      // Sidebar foot: one icon beside Settings, opening the trash panel.
      register('sidebar.footer.action', {
        id: NS + '-trash',
        order: 50,
        label: function () { return translate()('trash.open') },
        locale: NS,
        inject: function () { return { ui: ui, t: translate() } },
      }, TrashSidebarButton)
      register('shell.overlay', {
        id: NS + '-trash-panel',
        order: 60,
        label: function () { return 'dsh-enhancer' },
        locale: NS,
        inject: function () { return { ui: ui, t: translate() } },
      }, TrashPanelOverlay)
      return function () {
        for (const dispose of disposers) {
          try { dispose() } catch (error) { /* already gone */ }
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * Plugin apply                                                       *
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      const doc = typeof document === 'undefined' ? null : document
      const win = typeof window === 'undefined' ? null : window
      const warnOnce = function (message) {
        try { console.warn('[dsh-enhancer] ' + message) } catch (error) { /* ignore */ }
      }

      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }) }, 'dsh-enhancer: dictionaries')
      const bindLocale = function () { return ctx.locale.bind(NS) }

      const store = createStore()
      const trashStore = createTrashStore()
      const trashUi = createTrashController(trashStore, bindLocale)

      ctx.effect(function () { return installStyles(doc) }, 'dsh-enhancer: styles')
      ctx.effect(function () { return installWorkspaceProjection(ctx, store, { warn: warnOnce }) }, 'dsh-enhancer: projection')
      ctx.effect(function () { return installTrashProjection(ctx, trashStore, { warn: warnOnce }) }, 'dsh-enhancer: trash projection')
      ctx.effect(function () { return installDomBridge(doc, win, store, bindLocale, { warn: warnOnce }) }, 'dsh-enhancer: menus')
      ctx.effect(function () { return installSync(ctx, store, { warn: warnOnce }) }, 'dsh-enhancer: host sync')
      ctx.effect(function () { return installTrashSlots(ctx, trashUi, bindLocale, { warn: warnOnce }) }, 'dsh-enhancer: trash slots')
      // One boot fetch so the projection already knows the trashed ids before
      // the first sidebar paint.
      ctx.effect(function () {
        trashUi.loadTrash()
        return function () {}
      }, 'dsh-enhancer: trash bootstrap')

      ctx.effect(function () { return function () { store.dispose() } }, 'dsh-enhancer: store')
      ctx.effect(function () { return function () { trashStore.dispose() } }, 'dsh-enhancer: trash store')
    }

    exports.apply = apply
    exports.inject = ['locale', 'workspaces', 'sessions', 'slots']
    exports.__test = {
      createStore: createStore,
      normalizeRemoteState: normalizeRemoteState,
      filterProjection: filterProjection,
      mergeArchived: mergeArchived,
      menuKindFromText: menuKindFromText,
      showHiddenLabelText: showHiddenLabelText,
      installWorkspaceProjection: installWorkspaceProjection,
      installDomBridge: installDomBridge,
      installSync: installSync,
      createTrashStore: createTrashStore,
      createTrashController: createTrashController,
      installTrashSlots: installTrashSlots,
      installTrashProjection: installTrashProjection,
      TrashMenuItem: TrashMenuItem,
      TrashDialog: TrashDialog,
      TrashPanel: TrashPanel,
      TrashPanelOverlay: TrashPanelOverlay,
      TrashSidebarButton: TrashSidebarButton,
      formatBytes: formatBytes,
      relativeTimeText: relativeTimeText,
    }
    return module.exports
  },
  })
} catch (error) {
  const message = String((error !== null && error !== undefined && error.message) || error)
  if (!/duplicate factory registration/.test(message)) throw error
}
