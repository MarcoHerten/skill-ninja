# Collections and profiles travel with the store

ADR-0015 put collections in `~/.skill-ninja/config.json` and recorded, as a
consequence, that they "do not travel — not with the store, not to another
machine (unless the user copies their config)". ADR-0014's profiles lived
config-side the same way. Once the store became a visible, GitHub-pushed
repository (ADR-0016), that consequence turned into the wrong trade: the
fresh-machine story is *clone the store repo* — and the personal bundles you
curated (collections, per-project profiles) were exactly the part that stayed
behind. ADR-0015 named its own exit clause: "if collections ever need to be
shared or machine-synced, that is a new decision superseding this one." This
is that decision.

## Decision

**Collections and profiles move store-side.** Each is a single JSON file at
the canonical store's root — `<store>/collections.json` and
`<store>/profiles.json` — with the same shape the config keys had
(`{ "<name>": ["pattern"|"skill name", …] }`).

- **One source of truth.** `collection save | forget` and
  `profile save | forget` write the store file and commit it
  (`collection save <name>` / `profile forget <name>` / the profile
  equivalents), pushed when a remote is configured — the `cat assign`
  pattern. The views (`cat @<name>`, `find @<name>`, the page filter,
  `--collection`, `profile apply | lift | list`) resolve from the store file.
  The config keys are retired; `init`'s re-seeding no longer carries them.
- **Travel is automatic.** Clone the store on a fresh machine, run `init`,
  and the bundles are back — no export/import step to forget, no sync
  semantics to drift. (Machine-specific config state — the ZCode-disable
  ledger, agents, vaults — stays config-side and still does not travel.)
- **One-time migration.** `init` captures config-side `collections` /
  `profiles` from a pre-v1.5 setup *before* re-seeding and writes them into
  the store files — only where the file does not already exist, so a store
  that traveled with a clone is never clobbered by stale local config. The
  re-seeded config drops the keys; the migration is reported on stdout.
- **The ADR-0015 core stands.** A collection remains the owner's view, not
  data about the skill: one file at the store root, never per-skill stamps.
  The store is the owner's private repo; "never in the *product's* repo" is
  unchanged.

## Considered Options

- **Dual homes (config + store, kept in sync)** — rejected: two truths,
  conflict rules, and a sync that can silently pick a side. Storage moved
  wholesale instead.
- **Explicit `collection export | import` commands** — rejected: a manual
  step nobody remembers (the manual-remote precedent); travel should be a
  property of where the data lives, not a chore.
- **Whole-config sync with the store** — rejected: config mixes machine
  state (agents, vaults, the ZCode-disable ledger with absolute paths) that
  must never travel.

## Consequences

- The store repo's history gains `collection …` / `profile …` commits — the
  curation itself is now versioned and answerable ("when did I build the
  nils bundle?").
- A malformed or missing list file degrades to "no collections/profiles" —
  the lists are filters, never load-bearing state a view should die on.
- Sharing a store (cloning someone else's) imports *their* bundles — inert
  by construction (patterns that match nothing resolve to nothing).
- ADR-0015's "Consequences" section is superseded where it says collections
  do not travel; its decision rationale (owner's view, not skill data) is
  reaffirmed, now with the store root as the home.
