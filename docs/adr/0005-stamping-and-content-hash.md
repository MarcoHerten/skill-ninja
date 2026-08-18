# Stamping & content-hash scheme for `add`

`skill-ninja add` writes **frontmatter stamps** into the stored `SKILL.md` so
later commands (`diff`, `status`) can identify a Skill, its version, its
**Provenance**, and detect content changes via a **content hash**. This ADR is
THE contract T5 (`diff`) depends on, so it is precise about every field and about
exactly which bytes are hashed.

The stamps also have a human-readable projection: the per-skill `CHANGELOG.md`
written next to `SKILL.md`, defined in
[ADR-0012](0012-per-skill-changelog.md). It is a sibling file — never part of
the body, never part of the content hash.

## Decision

### Where stamps live

At the top of the stored `SKILL.md`, as YAML-ish frontmatter delimited by `---`
(the minimal format ADR-0003's parser reads). Any frontmatter present on the
incoming skill is **replaced** by the stamped block — Skill Ninja owns the
canonical copy's stamps — while the skill **body** is preserved verbatim.

### Keys written

| key | value |
| --- | --- |
| `name` | the Skill name (incoming frontmatter `name`, else the source folder's basename, else `--name`). |
| `description` | the agent-activation text — preserved from incoming frontmatter, carried forward from the prior stored version on re-add when the incoming version has none. |
| `category` | the category stamp (ADR-0013), quoted free text. Omitted when unset. Same carry-forward rule as `description`; `cat assign` writes/updates it in place (frontmatter-only edit — body, version, and hash untouched). |
| `version` | semver-ish. New skill → `1.0.0`. Re-add with **changed** content → PATCH bump (`1.0.0`→`1.0.1`). Re-add with **identical** content → version unchanged. Unparseable prior version → `1.0.0`. |
| `updated` | ISO date (`YYYY-MM-DD`) of this ingest. |
| `hash` | SHA-256 **content hash** (see below). Top-level, not under `provenance`. |
| `provenance` | nested object (see below). |

### Provenance object

```
provenance:
  source: received      # authored | received | external (the origins / tiers)
  from: <source>        # who/where: the source arg (folder/file path, URL, repo), or --from
  imported: 2026-08-13  # ISO date of this ingest (== updated)
  derived_from: <hash>  # prior content hash when re-adding an existing skill; null otherwise
```

Defaults (all overridable on the CLI):

- `source` — `external` for a repo/URL source; `received` for a folder/file/prompt. Override with `--source authored|received|external`.
- `from` — the source argument as the user gave it (folder/file path, URL, or `owner/repo`). Override with `--from <text>`.
- `imported` — today's date (same value as `updated`).
- `derived_from` — the previously stored `hash` when the skill name already exists in the store; otherwise `null`.

### Content hash — exactly which bytes are hashed

The **content hash is the SHA-256 of the Skill body** — the markdown content
**after** the frontmatter block — NOT the whole file. `version` / `updated` /
`provenance` are stamps ABOUT the content; hashing only the body means the hash
changes **if and only if the actual instructions change**, which is exactly what
`diff` needs to answer "did the content change?".

Body extraction rule (deterministic; T5 reproduces it verbatim):

1. Split the content into lines on `\n`.
2. If the first line is not exactly `---`, the body is the whole content.
3. Otherwise scan for the next line equal to `---` (the closing fence). The body
   is every line **after** that closing-fence line, rejoined with `\n`.
4. If no closing fence is found, the body is the whole content (lenient).

The hash is:

```
crypto.createHash('sha256').update(body, 'utf8').digest('hex')   // 64 hex chars
```

No trimming or other normalization beyond the extraction rule. Because the
stored body is the incoming body verbatim, the stamped `hash` always equals
`sha256(stored body)`; `diff` can recompute the body hash of any stored SKILL.md
and compare it to the stamp (tamper detection) or to another skill's body hash
(change detection).

### Version chain

On re-add, `derived_from` is set to the previously stored `hash`, linking
version N+1's content back to version N. This is the lineage `diff` walks
("what changed since the stored version").

## Why

- **Body-only hash** yields a stable content identity independent of stamping
  churn (`updated`/`version` change every ingest; the instructions may not).
- A **top-level `hash`** is a first-class stamp `diff` / `status` read directly.
- **`derived_from`** makes version lineage explicit and machine-readable without
  a separate manifest (SPEC.md, "No anti-patterns": the stamps ARE the record;
  status is computed on demand).

## Consequences

- `add` replaces any incoming frontmatter; a skill that carries its own
  frontmatter loses it in the canonical copy (its body is kept). Intentional:
  Skill Ninja owns the canonical stamps.
- The body-extraction rule must stay stable; T5 reproduces it exactly.
- Dates are day-granular (`YYYY-MM-DD`); sufficient for v1 provenance.
- The hash is a content identity, not a security guarantee — a crafted skill can
  still hash to anything; trust comes from **Provenance** + the safety check, not
  the hash.

## Update (2026-08-17 — bulk `ingest`, ADR-0009/0010)

The v1.1 bulk pipeline stores winners with the same stamp block and the same
body-only hash, with two refinements this ADR now covers explicitly:

- **Unstamped incoming frontmatter is preserved, not replaced.** `add` keeps
  only `description` (and `relation`) from incoming frontmatter; `ingest`
  keeps every non-stamped line verbatim (the kept-lines mechanism ADR-0010
  introduced for wrapped prompts — `tags`, `category`, custom keys survive).
  This generalizes SPEC.md's implementation decision ("stamps add to the
  skill's own frontmatter without dropping it; the `description` is
  preserved"); stamped keys always win. The body and its hash are unaffected —
  frontmatter is never hashed.
- **`derived_from` may carry a lineage list.** Under `ingest`, a cluster
  winner that superseded divergent variants records their content hashes
  comma-joined (`derived_from: <hash>, <hash>, …`), per ADR-0009's
  "losers are not stored — the winner's provenance records the lineage".
  `add`'s single-prior-hash form is the N=1 case; consumers must treat the
  field as free-text lineage, not assume one 64-hex hash.

## Update (2026-08-18 — category stamps, ADR-0013)

The stamp block gains an optional `category` key (see the table above): quoted
free text, emitted only when set, serialized by the same `serializeStamps`
(every writer keeps one deterministic key order). Two invariants carry over:

- **`cat assign` is a frontmatter-only edit.** It replaces/inserts exactly one
  `category:` line in the stored copy and touches nothing else — the body,
  `version`, `updated`, and the content hash never move, so a categorization
  is never a content change in `diff`'s eyes and never bumps a version.
- **The stamp is not a content signal.** Like frontmatter generally, the
  category line is outside the hashed body; it is metadata about the skill,
  not part of its instructions.

## Update (2026-08-18 — availability stamps, ADR-0014)

The availability layer adds three more optional frontmatter keys, written only
by `ninja on|manual|off` (never by `add` — re-adding a skill that carries them
is refused until `ninja on` clears them):

- `availability: "manual" | "off"` — the Availability state; absent = Active.
- `activation_text` — while Manual, the preserved original `description`;
  switching back to Active restores it to `description` verbatim.
- `disable-model-invocation: true` — while Manual, for the Claude-Code-family
  roots that honor the key natively.

All three follow the `cat assign` invariants: frontmatter-only edits (the
`availability <name>`-style commits record them; no CHANGELOG entry), body and
content hash untouched, hash-invariant by construction. The placeholder
description written while Manual is a single-line quoted scalar, and restoring
`activation_text` re-serializes it the same way `add` does — multi-line or
block-scalar originals come back folded to one line, matching how the stamp
serializer has always treated descriptions.
