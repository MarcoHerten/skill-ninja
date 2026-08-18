# Per-skill CHANGELOG.md

Issue #7 (ported from the personal skill-intake workflow): the stamps of
ADR-0005 and the store's git log record a Skill's history machine-first —
`version`, `updated`, `hash`, `derived_from` — but never produced the
human-readable per-skill changelog the intake workflow writes by hand (the
reference is a curated skill like `landingpage-architekt`: first-version entry,
per-version what-changed, intake notes, maintenance hints). This ADR defines
the contract under which the engine writes that file itself.

## Decision

Every skill the engine stores in the **canonical store** carries a
`CHANGELOG.md` next to its `SKILL.md`. One shared writer module
(`engine/changelog.js`) renders every entry — `add`'s create path, `add`'s
update path, and `ingest --apply`'s winners — so all paths produce the same
shapes and obey the same preservation rules.

### File layout

```
# Changelog — <name>

<author preamble — verbatim, from an incoming CHANGELOG.md, its own H1 dropped>
<bootstrap note — only when the file starts on an update, see below>

## v1.0.0 (2026-08-18)

- Ingested by Skill Ninja from "<provenance.from>" (source: <source>).
- Relation: "<provenance.relation>".            ← only when set

## v1.0.1 (2026-08-18)

- Content update: N lines added, M lines removed, K lines changed.
- Supersedes prior content, hash ab12cdef….    ← only when a prior hash exists
- Relation: "<provenance.relation>".            ← only when set
```

- **Blocks are separated by exactly one blank line; entries are chronological
  and append at the end.** Appending never rewrites what is already stored, so
  an append leaves every earlier byte untouched.
- **The entry is the human-readable projection of the stamps** that version
  carries: version, date, `provenance.source`/`from`/`relation`, the change
  counts (`summarizeChanges` over the same `lineDiff` `diff` reports — one
  counting, not two), and `derived_from` as the superseded hash (short form).
- **Bulk winners** (`ingest --apply`) get a batch entry instead of the single-
  ingest first entry: `Bulk ingested from batch "<directory basename>"`, plus
  the superseded lineage (`Won its cluster over N superseded variant(s):
  <short hashes>` — only when divergent variants lost; identical-copy losers
  share the winner's hash and supersede nothing).

### When the file is written

| moment | behavior |
| --- | --- |
| `add`, new skill | create: header + author preamble (if the source carries a `CHANGELOG.md`) + first entry |
| `add`, re-add, content changed | append the version entry; **bootstrap** (create with an explicit note that earlier history lives in the store's git log) when the stored skill predates this feature — nothing is retro-fabricated |
| `add`, re-add, content identical | file untouched, byte-identical (the idempotent no-op, like the version stamp) |
| `ingest --apply`, winner stored | create: header + author preamble + batch entry |
| `ingest --apply`, already-stored / needs-decision | file untouched — skipping the store write skips the changelog write |

### Preservation rules — the engine owns the file, not the prose

- `CHANGELOG.md` joins `SKILL.md` as a file the **store owns**: it is excluded
  from plain bundled-asset copying in every path, so an incoming copy can never
  wipe the generated history.
- **Author content is preserved, never merged.** On first ingest the incoming
  skill's own `CHANGELOG.md` content is carried verbatim as the preamble (its
  leading `# Changelog` H1 is dropped — the generated header replaces it — and
  the blank lines around the block are normalized so the one-blank-line block
  separation holds; every other byte is preserved).
  On re-add the stored file is authoritative and append-only; a changed author
  changelog in the incoming folder is not merged (free-form text cannot be
  merged deterministically, and overwriting would lose the generated lineage —
  the worse failure). The body changes that matter surface in the diff.
- **The engine never drafts maintenance hints, intake verdicts, or any other
  editorial prose.** Those stay author/agent judgment (the skill-intake rule);
  the engine only preserves them.

## Considered Options

- **Rely on the store's git log alone** — rejected: the log is machine-first,
  records store mechanics (not per-version what-changed), and says nothing for
  users who consume a skill folder without the store.
- **Newest-first entries (keep-a-changelog order)** — rejected: prepending
  rewrites the whole file on every update; appending keeps earlier bytes
  stable, which is what the identical-re-add idempotency promises.
- **Changelog as frontmatter (`history:` in SKILL.md)** — rejected: it would
  change the SKILL.md bytes and churn the body/stamp contract of ADR-0005 for
  every reader that does not care about history.
- **Merging author changelog edits on re-add** — rejected: no deterministic
  merge of free-form text; overwrite loses generated history. Documented
  consequence above.

## Consequences

- `CHANGELOG.md` is **not** part of the ADR-0005 content hash — it is a
  sibling file, not SKILL.md body; `diff`, the comparables check, and
  duplicate detection are unaffected by construction.
- The file lands in the same commit as the skill (`add`) resp. the batch
  (`ingest --apply`) — the changelog and the content it describes are one
  approval unit.
- `doctor`'s consolidation copies whole skill directories, so a consolidated
  skill keeps its changelog; it never re-stamps it (same rule as SKILL.md).
- Existing stored skills get their changelog **on their next changed re-add**
  (the bootstrap path) — no bulk migration, no retro-fabricated history.
