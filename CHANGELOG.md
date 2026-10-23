# Changelog

All notable changes to `@adamcjm/dsh-enhancer` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

This package is the successor of `@adamcjm/dsh-workspace-visibility`. Its 0.x history is
not repeated here; it lives in that repository. The rename makes room for further workspace
menu enhancements without changing the package name again.

## [Unreleased]

## [1.0.1] — 2026-10-23

### Fixed

- The Host half no longer fails activation on a real Cordis context: a context proxy throws
  when a plugin reads a service it was not injected with, so reading the `openWorkspaceFolder`
  test seam is now guarded by `try`/`catch` and falls back to the platform launcher. 1.0.0
  failed to activate with `cannot get property "openWorkspaceFolder" without inject`.
- The Host test suite now mounts the plugin behind a proxy that mimics that Cordis behaviour,
  so the regression cannot come back unnoticed.

## [1.0.0] — 2026-10-23

### Added

- **Open folder** in every Workspace row's "…" menu: opens the workspace directory in
  Finder (macOS), Explorer (Windows) or `xdg-open` (Linux). The Host resolves the path from
  the workspace registry, so the page only ever sends a workspace id; the directory is the
  canonical `fs.realpath` captured at registration, unaffected by renaming the workspace.
- The entry reports failures in place: **Folder no longer exists** for a deleted directory
  (`status() === 'missing-dir'`), **Could not open** for a failed launcher or an unsupported
  platform.
- Host route `POST /dsh-enhancer/open-workspace`, answering `{ ok, path }` on success and a
  structured `{ ok: false, error }` otherwise.

### Changed

- Package renamed from `@adamcjm/dsh-workspace-visibility` to `@adamcjm/dsh-enhancer`, with a
  deliberately generic name so future menu enhancements fit without another rename.
- Every internal identifier follows: client factory id, locale namespace, route prefix
  (`/dsh-enhancer`), stylesheet id, symbol keys and `data-dsh-enh-*` attributes.
- State file moved to `$DSH_HOME/storages/dsh-enhancer.json`.

### Migration

- On first start the previous package's `workspace-visibility.json` is adopted once: it is
  copied to `dsh-enhancer.json` and left in place so a rollback still works. Hidden
  workspaces and the Show-hidden switch survive the upgrade.
- Both packages must not be enabled at the same time; each injects its own menu entries, so
  the workspace menu would show duplicates.

### Carried over from 0.2.7

- Hide workspace / Unhide workspace in the Workspace row menu, with the hidden workspace's
  sessions kept out of the sidebar through a view-only archived projection.
- Show hidden workspaces (N) switch in the View options menu.
- Durable Host state with cross-process sync (Desktop and `dsh web` share `$DSH_HOME`) and
  an SSE stream for live updates.
