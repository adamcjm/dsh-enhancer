# @adamcjm/dsh-enhancer

[![npm version](https://img.shields.io/npm/v/@adamcjm/dsh-enhancer.svg)](https://www.npmjs.com/package/@adamcjm/dsh-enhancer)
[![license](https://img.shields.io/npm/l/@adamcjm/dsh-enhancer.svg)](LICENSE)

**English** | [中文](docs/README.zh-CN.md)

A [DeepSeek Harness](https://github.com/omdsh-dev/dsh) plugin that adds the small,
everyday operations the shipped workspace menus are missing. It is deliberately named
after the *area* rather than one feature, so new menu enhancements can be added without
renaming the package again.

Today it ships three things:

| Where | Entry | What it does |
| --- | --- | --- |
| Workspace row → "…" menu | **Open folder** | Opens the workspace's directory in Finder, Explorer or your file manager |
| Workspace row → "…" menu | **Hide workspace** / **Unhide workspace** | Hides the workspace and every session it owns from the sidebar |
| Sidebar → View options | **Show hidden workspaces (N)** | Reveals hidden workspaces again so they can be restored |

Display-only by design:

- no archive, unarchive, rename, move, pin or delete calls;
- no changes to workspace records, session logs or the archive set;
- opening a folder is read-only: it launches the OS file manager and nothing else;
- the only state written is one small Host file
  (`$DSH_HOME/storages/dsh-enhancer.json`).

## Install

```bash
dsh plugin --profile <profile> add @adamcjm/dsh-enhancer
```

Or wire it by hand in the profile's `package.json`:

```json
{
  "dependencies": {
    "@adamcjm/dsh-enhancer": "^1.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "@adamcjm/dsh-enhancer"]
    }
  }
}
```

Restart the Host (or let the profile's live patch reload pick it up) and refresh the Web UI.

### Local development

Point the profile at this checkout instead of the registry:

```json
{
  "dependencies": {
    "@adamcjm/dsh-enhancer": "link:/absolute/path/to/dsh-enhancer"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "@adamcjm/dsh-enhancer"]
    }
  }
}
```

`npm test` runs both halves with zero dependencies: the browser half in a `vm` sandbox
with a fake DOM, the Host half against a temp `DSH_HOME` and Node-style request/response
fakes. The suite never launches the real file manager.

## Usage

### Open a workspace folder

Click the "…" button on any workspace row and choose **Open folder**. The Host resolves the
directory from the workspace registry and launches:

| Platform | Command |
| --- | --- |
| macOS | `/usr/bin/open <path>` |
| Windows | `explorer.exe <path>` |
| Linux | `xdg-open <path>` |

The entry reports failures in place instead of dismissing the menu silently:

- **Folder no longer exists** — the registered directory is gone (`status()` is `missing-dir`);
- **Could not open** — the launcher could not be spawned, or the platform is unsupported.

The page never sends a path. It sends only a workspace id, and the Host looks the directory
up itself, so a stale row can never make the Host open an arbitrary folder. The registered
path is the canonical `fs.realpath` of the directory at registration time, which means it is
unaffected by renaming the workspace (`rename` only changes the display title).

### Hide and restore workspaces

1. **Workspace row → "…" menu → Hide workspace** — the row and all of its sessions disappear.
   While hidden rows are visible again, the same entry reads **Unhide workspace**.
2. **Sidebar → View options → Show hidden workspaces (N)** — a persisted switch that reveals
   every hidden workspace; the label carries the current hidden count.

Hidden ids live on the Host in `$DSH_HOME/storages/dsh-enhancer.json`. The browser keeps no
copy: it fetches the state once, then receives every change over an SSE stream
(`/dsh-enhancer/stream`), so Desktop and `dsh web` (two Host processes sharing one
`$DSH_HOME`) stay in sync without a refresh. Mutations travel as increments, so two clients
hiding different workspaces cannot overwrite each other.

## How it works

- **Hiding** never touches the DOM. The plugin wraps the `workspaces.list` client model
  (`getSnapshot`/`subscribe`) and projects a filtered snapshot, so the sidebar, its search
  results and the Hero workspace picker all hide the workspace from one place. Sessions
  belonging to a hidden workspace are unioned into a *view-only* archived set so the shipped
  grouping cannot trail them into "Ungrouped" — nothing is written to the archive.
- **Menu entries** are DOM additions. The shipped Workspace row menu and View options menu
  are hardcoded arrays with no slot in DSH 0.2.1-rc, so the plugin appends entries that clone
  the shipped item's own classes. A `MutationObserver` finds the menu portal after it opens.
- **The Host half** owns the durable state and the `open-workspace` action. Opening is a
  detached `spawn` with `stdio: 'ignore'`, so the HTTP request resolves as soon as the
  launcher exists.

## Upgrading from `@adamcjm/dsh-workspace-visibility`

This package replaces it. The hidden-workspace feature is identical, and the first start
adopts the old state file once, so your hidden list survives the upgrade.

```bash
dsh plugin --profile <profile> remove @adamcjm/dsh-workspace-visibility
dsh plugin --profile <profile> add @adamcjm/dsh-enhancer
```

Migration details:

- `$DSH_HOME/storages/workspace-visibility.json` is read once, copied to
  `dsh-enhancer.json`, and **left in place** so a rollback still works.
- Do not keep both packages enabled at the same time: each one injects its own menu entries,
  so the workspace menu would show duplicates.

## Compatibility

- DSH 0.2.1-rc or newer (`workspaceRegistry` Host service, `workspaces.list` client model,
  locale service, `webServer` route carrier).
- Node.js 20+ in the Host process.
- macOS, Windows and Linux. "Open folder" requires a desktop session; on a headless Host the
  route answers with `open-failed`.
- The Host that serves your page is the one that opens the folder. With a remote Host, the
  file manager opens on the remote machine (or fails), never on your laptop.

## License

MIT
