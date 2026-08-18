# Cached inventory and skill discovery

`skill-ninja init` analyzes the machine and writes a **cached inventory** — a JSON
snapshot of every **Skill** discovered across the configured **scopes**, plus any
broken symlinks. This is the data layer `status` / `doctor` (later tickets) read.
There is no manually-maintained catalog: the cache is regenerated wholesale on
every `init` (SPEC.md, "No anti-patterns"; status is computed on demand).

## Decision

### Skill discovery rule

A **Skill** is discovered by finding a `SKILL.md` file. Discovery walks each
scope's directory tree with one rule:

> When a directory contains a `SKILL.md`, it is recorded as a skill and the walk
> does **not** descend into that directory — its subdirectories are the skill's
> bundled assets (e.g. `engine/`), not more skills. Otherwise the walk descends
> into subdirectories.

This single rule supports every realistic layout uniformly:

- bare skill directly under an **agent root**: `<root>/SKILL.md`
- skill one level down: `<root>/<skill-name>/SKILL.md` (the common case for
  `~/.claude/skills`, `~/.zcode/skills`, `~/.agents/skills`)
- skills nested in **vault** note folders and in **project** working directories
  (found by descent)

Common non-skill directories are skipped during the walk: `.git`, `node_modules`.

A skill's **name** is the frontmatter `name` field when present, otherwise the
basename of the directory that contains the `SKILL.md`.

### Scopes scanned

From `~/.skill-ninja/config.json`:

1. **agents** — each configured agent key resolves to its **agent root** (via the
   agent-root model, `agents.js`). Tool asymmetry is abstracted: one logical
   skill placed in several roots yields several inventory entries.
2. **vaults** — each configured vault path (`~`-expanded), walked for skills.
3. **projects** — a new config field, `projects: [...]` (`~`-expanded), listing
   project working directories to walk for `SKILL.md`. (Added by this ticket;
   `config.js#normalizeConfig` and the harness `DEFAULT_CONFIG` updated.)

A scope whose directory does not exist contributes nothing (no error).

### Broken symlinks

While walking, a directory entry that is a symlink whose target does not exist
(dangling) is recorded in the inventory's `broken` list — with its absolute path
and the scope it was found in — rather than dropped or raised as an error.
Symlink entries are identified from `readdir`'s `Dirent#isSymbolicLink()` (the
walk already enumerates entries); brokenness is detected by following the link
(`stat`) and catching `ENOENT`, so it never throws.

### Cache location

`~/.skill-ninja/inventory.json`. Overwritten on every `init` (idempotent).

### Schema

```jsonc
{
  "version": 2,                              // inventory schema version
  "generatedAt": "2026-08-13T12:00:00.000Z", // ISO timestamp of this scan
  "counts": {
    "skills": 3,                             // total skill occurrences
    "broken": 1,                             // total broken symlinks
    "byScanRoot": { "agent:claude": 2, "vault:/abs/vault": 1 }
  },
  "skills": [
    {
      "name": "skill-ninja",                 // frontmatter name, else dir basename
      "file": "/abs/.../SKILL.md",           // absolute path to the SKILL.md
      "dir":  "/abs/.../<skill-name>",       // absolute dir containing SKILL.md
      "resolved": "/abs/.../<skill-name>",   // realpath of dir (v2; symlinks resolved)
      "symlink": false,                      // v2: is this occurrence's dir a symlink?
      "scanRoot": {
        "kind": "agent",                     // "agent" | "vault" | "project"
        "ref":  "claude",                    // agent key, or abs path for vault/project
        "root": "/abs/.claude/skills"        // the scan root (absolute)
      },
      "version":    "1.2.0",                 // parsed from frontmatter, else null
      "updated":    "2026-07-01",            // parsed from frontmatter, else null
      "provenance": {                        // parsed from frontmatter, else null
        "source": "authored",
        "from": "Marco",
        "imported": "2026-06-01",
        "derived_from": null
      },
      "tier":  "external",                   // "external" when skills.sh-attributed, else null
      "external": { "source": "friend/repo", "computedHash": "…" },
      "hash":  "ab12cd34…"                   // body content hash (ADR-0005)
    }
  ],
  "broken": [
    {
      "path":  "/abs/.../dangling-skill",    // absolute path of the broken symlink
      "scanRoot": { "kind": "agent", "ref": "claude", "root": "/abs/.claude/skills" }
    }
  ]
}
```

The `skills` list is **one entry per physical occurrence** (a skill at one
location), not grouped by name. A skill present in several roots (tool
asymmetry) or duplicated therefore appears once per location; `status` groups by
`name` to surface duplicates and tool-asymmetry spread. Per-occurrence entries
preserve per-location `version` / `provenance` (two copies of a skill can differ).

**Schema v2** added per-occurrence symlink awareness: `symlink` (is the
occurrence's directory a symlink?) and `resolved` (its `realpath`). This is what
lets `status` tell a **healthy linked spread** — every occurrence resolves to one
canonical copy, whether the links point into the canonical store (`add`) or into
one of the agent roots (skills.sh's install pattern) — apart from a loose-copy
duplicate, without re-scanning the filesystem. Consumers comparing locations
against each other compare `resolved` paths (the walked `dir` may contain
symlinked ancestors).

### Frontmatter parsing

YAML-ish frontmatter at the top of `SKILL.md`, delimited by opening and closing
`---` lines, is parsed with a minimal built-in parser (no YAML dependency): top
-level `key: value` pairs plus a nested `provenance:` object (2-space-indented
children). `version`, `updated`, and `provenance` are extracted where present;
absent or unparseable frontmatter yields `null` for each field — `init` never
throws on a malformed `SKILL.md`.

## Why

`init`'s job is to produce a stable, complete snapshot of the skill landscape.
A flat per-occurrence list is the natural, lossless output of a scan and gives
later commands everything they need to compute duplicates, tool-asymmetry spread,
and per-location drift. The stop-at-`SKILL.md` descent rule keeps a skill's
bundled assets from being misread as nested skills. Recording broken symlinks
distinctly is what lets `doctor` later offer to repair them.

## Consequences

- `status` / `doctor` read `~/.skill-ninja/inventory.json` and group entries by
  `name`; they must call `init` (or check the cache) before reporting.
- Adding a new scope type means extending `buildInventory` and the `scope` shape.
- The frontmatter parser is intentionally minimal; only the documented fields are
  captured, unknown fields are ignored.
