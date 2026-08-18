# Category stamps and the catalog

Issue #10: with dozens of skills across agent roots, vaults, and the store, a
flat list stops answering "which of my skills are marketing skills?" or "do I
already have something for topic X?". Skill Ninja needs categorization —
analyze a skill, assign it a category, browse the landscape as a catalog.

The design input was a set of personal Python scripts over a skill export
(`analyze_argos_data.py` / `build_argos_dashboard.py`): a nice dashboard whose
categorization lived in a **hand-maintained name→category mapping inside the
script**. That mapping is SPEC.md's named anti-pattern ("no manual catalog") —
it broke on every rename round and scales to neither other machines nor skills
you don't own yet.

## Decision

**Categories are data on the skill, not a mapping in a script.**

- **The stamp.** A `category: "<free-form string>"` frontmatter key on the
  stored `SKILL.md`. It travels with the skill through `diff`, `add`, renames,
  and re-ingest: `add` carries a prior stored category forward on re-add when
  the incoming version has none (the same carry-forward `description` gets),
  and `ingest`'s kept-lines mechanism (ADR-0010) already preserves unknown
  frontmatter keys verbatim.
- **The assignment — `ninja cat assign <name> <category>`.** The engine writes
  the stamp onto the **stored copy only**: a frontmatter-only edit that
  replaces/inserts exactly one `category:` line, leaving every other line and
  the whole body byte-identical — so `version`, `updated`, and the content
  hash (ADR-0005 hashes the body) never move, and `diff` never reports a
  categorization as a content change. No CHANGELOG entry (ADR-0012 records
  content versions); the store's git log is the record (`categorize <name>`
  commit, pushed like every other). Skills outside the store are refused with
  a pointer to `add` — External skills belong to skills.sh and are never
  rewritten (ADR-0007). Re-assigning the same category is a no-op.
  **Which** category fits is the skill layer's call: the agent analyzes the
  skill (name + description) and proposes from the vocabulary, the user
  approves — the same engine-writes / agent-decides split as the safety check.
- **The vocabulary.** A default category list ships in the engine (generalized
  from the reference taxonomy: Strategy & Management; Marketing & Social;
  Content & Writing; Design & Documents; Education & Specialties; Meta & Agent
  Tooling). The config's `categories: [...]` replaces it — any configured
  array, including an explicitly empty one, replaces the defaults wholesale;
  only an absent/null field falls back to them. The list is user-only, never
  detected, and survives `init` re-seeding like `projects`. Stamps stay
  free-form: a category outside the vocabulary renders as its own group, and
  `cat assign` **warns but never blocks** so a typo doesn't silently fragment
  the catalog.
- **The catalog view — `ninja cat [<term>]`.** Reads the **cached inventory**
  (never re-scans): skills grouped under category headings in vocabulary order,
  then custom categories alphabetically, `Uncategorized` always last — the
  categorization backlog stays visible. Each entry is `name [tier] —
  description`; the header counts skills, categories, and uncategorized. A
  term filters to categories whose name contains it (case-insensitive); no
  match lists the categories present.
- **Inventory schema v3.** `init` captures `category` and `description` per
  occurrence (top-level frontmatter keys the parser already handles; absent →
  `null`). The catalog is a **view over the cache**, computed on demand —
  never a second artifact to keep in sync.
- **The page joins the catalog.** `ninja page` regroups its skills section
  under category `<h2>` sections using the **same** `groupByCategory` /
  tier-badge / description helpers `cat` uses (the one-implementation pattern
  the page already follows with `status`'s `groupSkills`). ADR-0011's
  constraints are untouched: no scripts, no network, self-contained — the
  catalog's search is the browser's find.

## Considered Options

- **The Python-dashboard approach (mapping dict + client-side-rendered HTML)**
  — rejected as the product mechanism: Python + PyYAML contradicts the
  Node-only runtime decision; it re-scans one flat directory with no
  multi-root/symlink/tier awareness; its hand-maintained mapping is the named
  anti-pattern; and its interactivity (embedded JSON + client-side rendering)
  was never the load-bearing requirement — offline/self-contained is, which
  static grouped sections deliver. Its good ideas (categories, per-skill
  descriptions, quality flags) are absorbed as data-model features instead;
  the quality flags are future `doctor`/`init` candidates.
- **A separate catalog file (JSON/HTML artifact listing skills + categories)**
  — rejected: a second thing to keep in sync, exactly what the cached
  inventory + on-demand views exist to avoid.
- **Engine-side auto-classification** (heuristics guessing categories) —
  rejected: deterministic guessing is brittle and unreviewable; the agent
  layer proposes, the user decides, the engine only validates and writes.
- **`status --category` filters** — rejected for now: the catalog is `cat`'s
  job; `status` keeps its location/duplicate focus.

## Consequences

- `assign` requires the skill to be in the canonical store; loose copies are
  `add`/`doctor` territory first (that is by design — the stamp lands on the
  canonical copy). "Never touches External skills" is enforced structurally:
  `assign` writes only under the store path, and the store holds Personal
  skills by definition (ADR-0007's two linking systems are separated by tier) —
  skills.sh's installed copies are never a write target.
- A group whose occurrences disagree on category shows the first scanned
  occurrence's category (one placement per skill); resolving the disagreement
  is a re-assign away.
- External skills appear in the catalog read-only when their own frontmatter
  carries a category; Skill Ninja never writes one for them.
- The inventory schema version moves 2 → 3; older caches simply lack the new
  fields (read as uncategorized) until the next `init` refresh.
