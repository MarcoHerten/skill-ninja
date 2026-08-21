# Manager UI: an interactive, local-only web interface

ADR-0011 gave the browser exactly one honest surface: a static status page
whose cockpit *proposes* a `/ninja …` command for the owner to copy and run.
That two-phase flow was the right call for a read-only view — but the
availability layer (ADR-0014), profiles (ADR-0017), and the new Notes and
Chat-Prompt exports are **write actions**, and driving writes by
copy-pasting generated commands into a chat is friction. The friction is not
cosmetic: the owner's agents stayed flooded precisely because switching a
skill to Manual cost more clicks-and-pastes than the context-window noise it
removed. The design session of 2026-08-21 settled the requirement — an
interface that operates the engine directly, speaks install language
("Global aktiv / Nur auf Aufruf / Aus"), and builds on the Clean Dashboard
design shipped on `feat/status-page-clean-dashboard`.

## Decision

- **New command `ui`.** `/ninja ui` starts a foreground local web server —
  Plain Node `http`, bound to `127.0.0.1` only, `--port` flag with a default,
  best-effort browser open — serving the **Manager UI**. It is not a daemon:
  it dies with the terminal, and a busy port is an error, never a steal.
- **The server is a thin adapter.** Every mutating button calls a JSON
  endpoint that invokes the same engine functions the CLI commands use (the
  `on`/`manual`/`off` apply path, `profile apply`/`lift`, the note save, the
  external removal of ADR-0020, the bulk manual migration). No rule gets a
  second implementation.
- **Two-phase approval survives as an explicit confirm.** Every mutating
  action first shows what it will do — the same plan text the CLI dry-run
  prints — and the click is the `--apply`.
- **Reads come from the cached inventory** (ADR-0003 contract); a Refresh
  action runs the engine scan on demand. The server never watches files and
  never re-scans on its own — `init` owns scanning.
- **v1 operating scope.** Availability switches, profile apply/lift, the
  Notes editor (`NOTE.md` in the canonical store, one commit per save), the
  three copy flavors (name / raw SKILL.md / Chat-Prompt), external removal
  (ADR-0020), and the bulk "own Actives → Manual" migration with preview.
  **Manual is the default availability for newly linked skills**; existing
  Actives migrate only through the explicit bulk action, never silently.
- **Copy flavors fetch on demand.** The Manager UI serves skill bodies via
  its API when a copy button is clicked; nothing is embedded wholesale.
  ADR-0011's story-#54 update (the *static* page copies the name only)
  stands unchanged — offline page size is that page's constraint, not this
  one's.

## Considered Options

- **More static-page copy-commands** — rejected: the copy-paste round trip
  is the friction being removed, not a feature to extend.
- **A TUI dashboard** — rejected: notes editing, filters, project pickers,
  and three clipboard flavors are materially better in a browser; the owner
  chose the web form factor.
- **A GUI application (Electron & co.)** — rejected: SPEC "Out of Scope"
  (no GUI application), and Plain Node keeps the zero-dependency rule.
- **A server with file watching / auto-rescan** — rejected: `init` owns
  scanning (ADR-0011's computed-on-demand model); refresh is a button, not
  a watcher.

## Consequences

- **ADR-0011 is amended, not replaced.** The static page remains the
  offline `file://` snapshot; the Manager UI is its interactive sibling.
  "No server" was the *status page's* constraint. The Manager UI inherits
  the same substance: loopback-only, no network use, no external assets,
  self-contained inline CSS/JS, and all interpolated values are data —
  names, paths, and skill bodies arrive escaped and can never inject
  markup.
- No new dependencies; the UI's tests drive the server on an ephemeral
  port.
- The server executes engine writes and is trusted exactly like the CLI
  that spawned it; there is no auth beyond the loopback bind.
- The install-language mapping is UI copy, not a mechanism change:
  linking, stamps, profiles, and the store work exactly as ADR-0014/0016/
  0017 define them.
