# External skill removal: delegated to skills.sh

ADR-0007 ("skills.sh installs, Skill Ninja manages") and ADR-0018 drew a
hard ownership line: **External skills belong to skills.sh** — audited,
never managed, re-linked, or switched. The flooding that motivated the
Manager UI (ADR-0019) sits exactly on the far side of that line: on Claude
Code the bulk of the context-window noise is external, `off`'s only
cross-agent disable path is ZCode's config (ADR-0014), and audit-only left
the owner no lever at all. skills.sh ships a `remove` command — a
delegation channel that keeps its ownership intact.

## Decision

- **Exactly two actions on an External skill in the Manager UI:** leave it
  as-is, or remove it — executed by delegating to
  `npx skills remove <name>` with the occurrence's scope (global vs.
  project, derived from its scan root). Skill Ninja never deletes
  skills.sh-tracked files and never edits `skills-lock.json` itself; the
  lockfile stays consistent because skills.sh performs its own removal.
- **No Manual for Claude Code externals.** Stamping
  `disable-model-invocation` into a skills.sh-tracked SKILL.md breaks its
  `computedHash`, and the next `skills update` silently reverts the stamp —
  a change that undoes itself is worse than none. ZCode externals keep the
  existing config-disable path (ADR-0014). This asymmetry is a documented
  boundary, not an oversight.
- **Personal skills keep `off`** — unlink everywhere, store retains the
  skill, reversible by `on`. There is no delete for Personal skills
  anywhere in the UI: the store is the archive, `off` is the exit.
- **Plugin-owned skills remain audit-only** (ADR-0018 untouched) — the
  agent's plugin manager is their removal channel, never Skill Ninja.

## Considered Options

- **Delete the files and rewrite `skills-lock.json` ourselves** — rejected:
  Skill Ninja would own skills.sh's state and race its updater.
- **Restamp external SKILL.md frontmatter for Manual** — rejected: the
  `computedHash` break makes `skills update` revert it silently.
- **Stay audit-only** — rejected: a manager without a removal lever cannot
  solve the problem it exists for.

## Consequences

- Removal runs skills.sh (`npx`, network at that moment); skills.sh's
  output is surfaced verbatim as the action's result. A skills.sh failure
  fails the action — nothing is half-removed by us.
- The glossary's External-skill entry now carries the removal rule
  (delegation only, on explicit request).
- `doctor` semantics are unchanged; a removed external simply disappears
  from the inventory at the next scan.
