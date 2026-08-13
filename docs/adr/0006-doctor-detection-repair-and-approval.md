# `doctor` — detection, repair, and the approval model

`skill-ninja doctor` detects problems across the **Skill** landscape and repairs
them, each repair applied only with the user's approval (Issue #6 / T6). It reads
the **cached inventory** written by `init` (ADR-0003) — it does **not** re-scan.
This ADR pins the approval model, the problem definitions, and the repair rules.

## Decision

### Approval model — no silent changes

The interactive per-fix approval lives in the **skill** layer (`SKILL.md` walks
the user through each repair). The deterministic **engine** models approval as an
explicit opt-in flag, so **nothing is changed by default**:

- `skill-ninja doctor` (no flag) — **detect + report** (a dry run). Every detected
  problem is listed in plain language with its proposed repair. The filesystem is
  **not modified**. Exit 0.
- `skill-ninja doctor --apply` — the explicit approval gate. Every proposed repair
  is applied, then a **summary of applied changes** is printed. Exit 0.
- `skill-ninja doctor --only broken|duplicates|orphans` — scope which problem
  types are considered (reported, and — with `--apply` — repaired). Default: all.

Hard rule: `doctor` without `--apply` **must not** modify the filesystem. This is
asserted by a test.

### What doctor reads

The cached inventory (`~/.skill-ninja/inventory.json`, ADR-0003) plus the
configuration (`loadConfig`, for the **canonical store** path). If no inventory
exists, `doctor` says so in plain language and points to `init` (exit 0). The
**dedup** and **orphan** features are store-relative; if `config.store` is unset,
`doctor` reports only broken links (with a hint to configure a store).

### Problem definitions

**Broken link** — straight from `inventory.broken[]`: a symlink whose target does
not exist (recorded by `init` with its path and scope).

**Duplicate** — a name that appears in **more than one** inventory occurrence
(the visible symptom of **tool asymmetry**: the same **Skill** spread across
roots). *But* a spread is only a **problem** when **at least one occurrence is a
loose copy**. To tell a problematic duplicate from a healthy link spread, `doctor`
**classifies** each occurrence against the filesystem (read-only `lstat`/
`readlink`):

- **store** — the occurrence's directory lives under `config.store` (the canonical
  copy).
- **link** — the directory is a symlink (a healthy link; tool asymmetry correctly
  handled by `add`/dedup).
- **loose** — a real directory, not under the store, not a symlink (a standalone
  copy the user never canonically ingested).

A spread with **no loose occurrence** is the healthy post-`add`/post-dedup state
and is **not** reported. A spread with ≥1 loose occurrence is a duplicate problem.

**Orphan** — a **solo** occurrence (its name appears exactly once) that classifies
as **loose**: a real copy floating in an **agent root** or **vault**, never
ingested into the canonical store and not linked to it. (A loose copy that is part
of a duplicate spread is handled by **dedup**, not orphan repair — this avoids two
repairs targeting the same occurrence.)

**Stale** is folded into v1 as: broken links (a stale/dangling link) and loose
copies (a stale, unmanaged copy). There is no separate "stale" finding type.

### Repairs (applied only with `--apply`)

**Broken link** → remove the dangling symlink (`unlink`). The safe v1 repair.

**Duplicate** → **consolidate to one canonical copy + links**, reusing `add`'s
linking pattern (`engine/links.js#linkSkill`):

1. The canonical content source is the occurrence under `config.store` if any,
   else the **first loose occurrence by sorted path** (deterministic). The dry run
   names this source so the user sees which content wins before approving.
2. Ensure `<store>/<name>/SKILL.md` exists — copy the source **Skill** (its
   `SKILL.md` and bundled assets) into `<store>/<name>` verbatim if the store does
   not already hold it. (The store copy is never removed.)
3. Replace **every loose occurrence's directory** with a symlink → `<store>/<name>`.
   Already-healthy links are left untouched.

Result: one canonical file in the store, the previously-loose locations now link
to it — **tool asymmetry resolved the Skill Ninja way** (one canonical copy +
links, *not* multi-target deploy). If two loose copies differ, the chosen
canonical content wins and the others are discarded (the user approved via
`--apply` after seeing the source in the dry run).

**Orphan** → **ingest into the canonical store + link**: copy the loose copy into
`<store>/<name>`, then replace its original location with a symlink → `<store>/<name>`.
(This is `consolidate` with a single location — the same primitive as dedup.)

`doctor` copies verbatim; it does **not** re-stamp `version`/`hash`/`provenance`
(stamping is `add`'s job, ADR-0005). A consolidated skill keeps whatever
frontmatter it already carried.

### Summary of applied changes

After `--apply`, a plain-language summary: how many broken links were removed, how
many duplicates were consolidated (and into which canonical store path), and how
many orphans were ingested. The summary is the "what changed" record (SPEC.md user
story #21).

## Why

- **Detection from the cache** keeps `doctor` consistent with `status` (both
  compute on demand from the inventory — SPEC.md, "No anti-patterns": no manual
  catalog).
- **Filesystem classification** is what distinguishes a *problem* (loose copies)
  from the healthy linked spread `add`/dedup produce. Without it, every tool-
  asymmetry link spread would false-positive as a "duplicate".
- **`--apply` as the approval gate** makes "no silent changes" testable and
  deterministic, while leaving per-fix approval to the skill layer.
- **Consolidation to one canonical copy + links** is the documented fix for tool
  asymmetry (CONTEXT.md), reusing `add`'s proven linking primitive rather than a
  new deploy mechanism.

## Consequences

- `doctor` performs read-only filesystem checks (`lstat`/`readlink`) during
  detection to classify occurrences; the dry run still mutates nothing.
- Dedup/orphan repair requires a configured `config.store`. Without one, only
  broken links are handled.
- `doctor` does not refresh the inventory after applying — re-run `init` then
  `doctor` to confirm a healthy landscape (the post-repair state is reasoned from
  the filesystem, not from a stale cache).
- Orphan detection excludes occurrences in duplicate groups (dedup owns those), so
  the two repair types never collide.
