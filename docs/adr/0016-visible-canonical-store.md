# The canonical store is a visible, nameable repo (`init --store`)

Skill Ninja's canonical store lived at `~/.skill-ninja/store` — hidden, its
name fixed by the tool's internals. A store nobody sees never feels like a
repository: the intended workflow — pushing it to a private GitHub remote so
every skill change is traceable through git history — never becomes a habit
because the thing itself is buried. The per-skill history was already being
written (`add`, `ingest --apply`, `cat assign`, and since ADR-0014 the
availability switches); this ADR gives it a home the user actually visits.

## Decision

- **The store default is visible**: `~/skill-ninja-store` — a named git
  repository directly in the user's home directory. The directory name doubles
  as the repository name the user pushes to GitHub. This supersedes the
  default-path line in [ADR-0008](0008-init-bootstraps-config-and-discovers.md)
  (`~/.skill-ninja/store`); everything else about init bootstrapping stands.
- **`init --store <name|path>`** selects the store. Resolution rule: a value
  with no path separators is a bare name resolved under `$HOME`
  (`skill-vault` → `~/skill-vault`); any other value is a filesystem path —
  `~` expanded against `$HOME`, absolute or relative as given. An empty value
  is a usage error (exit 2). The flag overrides the configured store for that
  run and is persisted as `store` in the seeded config. Without the flag the
  no-clobber rule applies unchanged: an existing configured store is
  preserved, re-detection never renames — existing setups (including
  pre-ADR-0016 `~/.skill-ninja/store` ones) keep working untouched.
- **Freshly created stores are seeded** — only when the directory did not
  previously exist: a fixed-template `README.md` (what this repo is + a
  keep-it-private hint; only the store name is interpolated — the engine
  never drafts editorial prose) and an initial `init store` commit through
  the shared best-effort git machinery (no git → README written, commit
  skipped silently). An existing directory pointed at by `--store` is never
  seeded, committed, or modified beyond `git init` when it has no `.git`.
- **Switching is reported, never executed**: when `init --store` moves the
  configured store away from a previous store path that still exists on disk,
  the summary says in plain language that the previous store was left
  untouched (skills, links, and history remain there). No move, no copy —
  relocation is explicitly out of scope.
- **Only the store became visible.** Config, the cached inventory, and the
  status page stay under `~/.skill-ninja`.

## Why

- **Traceability needed a visible substrate.** Every stored-skill change
  already lands as a commit — `add skill <name>`, the `ingest --apply` batch
  commit, `categorize <name>` (cat assign), and `availability <state> (…)`
  (ADR-0014) — pushed when a private remote is wired. A hidden directory gave
  that history nowhere to live in the user's awareness.
- **The name is the user's, not the tool's.** One visible repo that is
  obviously *the* repo — findable, openable, pushable without digging through
  dotfiles.

## Considered Options

- **Migrating existing stores to the new default** — rejected: moving
  `~/.skill-ninja/store` (or any configured store) and re-pointing agent-root
  symlinks is invasive, and the no-clobber rule already guarantees existing
  setups work untouched. Relocation stays a manual follow-up (move the
  directory, edit `store` in the config, re-run `init`, `doctor` to check
  links) — release-notes material, not tool behavior.
- **A separate `store_name` config knob** — rejected: the path (and its
  basename) is the single source of the name; a second knob could drift from
  it.
- **Auto-wiring the GitHub remote (`gh repo create`)** — rejected for now:
  the remote stays a documented manual step (`git remote add origin …`); a
  `gh`-aware post-init step is a future candidate.

## Consequences

- The inventory's store-as-scan-root (schema v4, ADR-0014) is
  default-path-agnostic: it reads `store` from the config, so the visible
  default changes nothing there — only `defaultStore` in
  `engine/discover.js` moved.
- First-run conversation lives in the skill layer (SKILL.md): propose the
  default name `skill-ninja-store`, let the user override it (name or path),
  then run the engine once with the answer — the engine stays non-interactive.
- The seeded README template is engine-owned prose; users may edit it freely
  (re-running `init` never re-seeds an existing directory).
