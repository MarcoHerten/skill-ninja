# Personal-tier heuristic for the `status --personal` filter

`skill-ninja status --personal` narrows the inventory view to the user's
**Personal** skills. The cached inventory (ADR-0003) carries no explicit tier,
so this ADR fixes the documented interpretation the filter applies.

## Decision

A skill occurrence is **Personal** when **either** holds:

1. It lives under the configured **canonical store** path (`config.store`,
   resolved from `~/.skill-ninja/config.json`) — i.e. its directory is the store
   itself or a descendant of it; **or**
2. Its `provenance.source === "authored"`.

A logical Skill (a name group) is shown by `--personal` when **at least one** of
its occurrences is Personal; all of that skill's locations are then listed (so a
personal skill that has leaked into an agent root still shows the spread).

## Why

CONTEXT.md defines the Personal tier as "a skill the user authored or received
and owns; lives in the user's canonical store, versioned under their control."
The inventory records where each occurrence physically lives and its parsed
provenance, but not the tier directly — so the tier is **derived** from those two
signals:

- **Store path** is the strongest ownership signal: anything under the canonical
  store is, by definition, owned by the user.
- **`provenance.source === "authored"`** covers the common case where a personal
  skill is *linked* into an agent root (so its directory is not under the store)
  but is still authored/owned. This is exactly the tool-asymmetry case: the
  canonical copy lives in the store, and a link sits in each agent root.

The disjunction (either signal) keeps the heuristic permissive and robust: a
skill need only satisfy one. `received`/`external` sources without a store
location are correctly treated as non-Personal.

## Consequences

- `status` loads config (`loadConfig`) to resolve `config.store`. If the config
  has vanished since `init`, `store` falls back to `null` and the heuristic
  falls back to the provenance signal alone (graceful, never crashes).
- The store is **not** itself a scanned scope (ADR-0003 scans agents, vaults, and
  projects only). So a skill only reaches the inventory via the store path when
  the user also points a `project` (or vault) at the store — which is the
  expected way the canonical store is observed today. A future ticket may scan
  the store natively; this heuristic already covers that without change.
- This is a **derived** classification, not stored state (SPEC.md, "No
  anti-patterns"). Re-running `init` and `status` always reflects the current
  landscape and config.
