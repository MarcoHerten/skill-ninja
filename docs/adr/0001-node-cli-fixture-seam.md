# Node CLI fixture seam

Skill Ninja's only automated test seam is the black-box Node CLI invoked against fixture filesystems (SPEC.md, "Testing Decisions"). We confirm that seam here so every later ticket tests through it.

## Decision

Tests spawn the engine's CLI entry — `node skills/ninja/engine/cli.js <command>` — as a child process inside a sandboxed fake `$HOME` (a fresh temp directory), and assert only on the process's stdout / exit code and the resulting filesystem state, never on internal modules. The fixture harness (`tests/helpers/harness.js`) builds the sandbox: a temp `$HOME` with the configured **agent roots** and an Obsidian **vault** planted, and `~/.skill-ninja/config.json` written; it then runs the CLI with `HOME` pointed at the sandbox and returns `{ stdout, stderr, exitCode }`. Runner is Node's built-in `node --test`; zero runtime dependencies (Node built-ins only).

## Why

This is the highest, most stable boundary: the **skill** (interface) drives the **engine** (muscle) via the CLI, and internal refactors — splitting or renaming modules — cannot break tests, because only the CLI contract (command in → stdout + filesystem out) is observed. It also fits the **tool asymmetry** model: every **agent root** and the **canonical store** resolve under `$HOME`, so pointing the engine at a fake `$HOME` is sufficient to fake the whole landscape.

## Conventions

- **Test directory is `tests/` (plural)** so the literal `node --test` script does not pick up helpers as no-op tests. (Node's default discovery treats every `.js` under a `test/` dir as a test.) New tests are `*.test.js` files under `tests/`, helpers go under `tests/helpers/`.
- **The harness imports no engine code.** To stay a black box it deliberately keeps a local copy of the agent-root model and `~`-expansion. This duplication is intentional (an independent assertion source), not a smell to refactor away.
