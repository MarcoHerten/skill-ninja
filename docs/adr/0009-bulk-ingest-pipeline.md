# Bulk `ingest` — a read-only, two-phase pipeline

Real-world skill collections arrive as messy directories: the same skill in up
to four packagings (folder, `.zip`, `.skill`, `.skill.zip`), version clusters of
eight-plus variants, renames documented only in prose, junk mixed in. `add` is
the curated single-skill path and cannot absorb that. This ADR pins the shape of
`/ninja ingest <dir>`, decided against two audited real-world samples (a
272-entry skills export and a 403-file prompt-library export).

## Decision

**A sixth command, not a mode of `add`.** `ingest <dir>` is its own pipeline;
`add` stays the curated single-skill dialog. Whether `ingest` reuses `add`'s
machinery internally is an implementation detail.

### Two-phase, doctor-style approval (per ADR-0006's model)

- `ingest <dir>` — **analyze + report**, a dry run. Candidates classified,
  clusters formed, per-cluster proposed resolution (winner + reason), junk list
  (each item + reason), safety findings, and `needs-decision` conflicts. The
  filesystem is not modified. Exit 0.
- `ingest <dir> --apply` — execute the approved batch, then print a summary of
  applied changes.

The skill layer walks the user through the report before apply; the user may
reject or skip entire clusters during that walkthrough.

### Read-only on the source

Ingest copies out of the directory. It never renames, moves, or deletes
anything in it. Sorting or cleaning the source directory itself is not ingest's
job (and would be a separate, explicitly approved feature if ever wanted).

### Store-only — no linking

Ingest never places links into agent roots (context hygiene, SPEC story #38).
It stores; making a stored skill available to agents afterwards is the existing
`add`/`status`-time choice. A bulk link command may follow later; v1 has none.

### Candidate classification

Every item in the directory is exactly one of:

- **skill package** — a folder containing a `SKILL.md`; an archive (detected by
  zip magic bytes, not by extension — `.skill` and `.skill.zip` are zips)
  containing one, with the `SKILL.md` at *any* nesting level or under
  non-standard names (`SKILL-UPDATED.md`, `SKILL_artemis_v3.md`,
  `kalliope-SKILL.md`); or a bare `SKILL.md` file, including ones with broken
  frontmatter (trivial delimiter damage is repaired, the item marked
  `needs-review`). Archives are unpacked with `__MACOSX`/`.DS_Store` entries
  filtered.
- **prompt document** — an `.md` without skill structure (ADR-0010).
- **junk** — skipped and reported, never deleted: `__MACOSX`/`.DS_Store`/
  `.bak*`, empty directories, loose non-package files (PDF, `*.html`, tooling
  `*.py`/`*.sh`/`*.json`), meta/navigation files (README, AGENTS.md,
  `00_START_HERE.md`, index/navigator/dashboard/lint artifacts) recognized by
  known patterns plus the residual "is neither package nor prompt".

Files **inside** a recognized package are bundled assets and always travel with
it (`.py`, `.sh`, `.yaml`, `LICENSE`, even large HTML). The inside/outside edge
is the only sharp classification boundary.

### Cluster resolution — deterministic where possible

Identity key: the normalized frontmatter `name` (fallback: the normalized
folder/file stem). Normalization: Unicode NFC (macOS export filenames are NFD),
version suffixes and copy markers stripped (`-v4`, `Kopie`, ` 2`, date codes),
special characters slugged (`—`, `×`, parentheses).

Winner priority within a cluster:

1. An unpacked folder beats an archive — folders are the maintained form (the
   audited export's README documents renames applied to folders only).
2. An explicit version signal beats file mtime (`v3` < `v4`, semver, date
   codes) — export mtimes are useless (Notion/zip resets them to export time).
3. Byte-identical members (content hash, ADR-0005) collapse silently.

### Losers are not stored

The report lists every non-winner with its content hash and the reason it lost.
The winner's provenance records the lineage (`derived_from`: superseded
variants). Because the source directory stays untouched, discarding losers
loses nothing.

### Divergent duplicates → `needs-decision`

Same identity, different content, no version signal (observed: a 54-file block
where the root copies were stale and the subfolder copies legally newer): no
rule can resolve this. The engine prepares a side-by-side (diff stats, content
hints); the **agent layer** proposes a batch resolution ("subfolder wins for
all 54 — contains the 2026-06 legal updates"); the user approves **once per
cluster group**, not per file.

### Re-ingest is idempotent by identity

Running ingest again over the same (or an updated) directory compares against
the store by name + content hash: identical → skipped as already stored;
changed → `needs-decision` with a diff. This is `add`'s comparables logic at
batch scale.

### Provenance, safety, commits

- Provenance stamped per winner as in `add` (ADR-0005); `provenance.from`
  labels the batch (e.g. `Nils-Prompts-Liste`), `imported` is the run date.
- The static safety check runs engine-side across all candidates; findings are
  a column in the report, not a per-item walkthrough.
- **One git commit per `--apply` run** (the batch approval unit, revertable as
  a whole), pushed to the private remote like `add` (ADR-0007 layering).

### v1 scope: local directories

Git repos and URLs remain `add`'s job.

## Why

- **A separate command** over a bulk mode of `add`: the economics differ —
  dozens of items, cluster decisions, one batch approval vs one curated
  per-item dialog. A sixth verb is honest about that.
- **Report-then-apply** over silent auto-rules: rules silently *wrong* on
  divergent content is the worst outcome; the doctor precedent already proved
  the pattern. Over a fully interactive per-item walk: user fatigue at 50+
  clusters — agent batch proposals with one approval per cluster group is the
  workable middle.
- **Store-only linking default**: bulk batches are typically content libraries
  (the audited prompt export), exactly what story #38 keeps out of coding
  agents' context.
- **Losers not stored**: a store that also archives every loser becomes a
  second chaos — the thing being cleaned up.

## Consequences

- `status` gains a provenance filter (own vs ingested-batch), and the store can
  grow by hundreds of skills without touching any agent root.
- Wrapped prompts without `description` sit inert until curated (ADR-0010).
- The engine must normalize filenames (NFC/slug) and sniff archives by content,
  not extension — tested against the two audited samples' exact pathologies
  (NFD umlauts, ` — ` em-dashes, four `SKILL.md` nesting positions).
