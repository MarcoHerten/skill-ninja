# Stamping & content-hash scheme for `add`

`skill-ninja add` writes **frontmatter stamps** into the stored `SKILL.md` so
later commands (`diff`, `status`) can identify a Skill, its version, its
**Provenance**, and detect content changes via a **content hash**. This ADR is
THE contract T5 (`diff`) depends on, so it is precise about every field and about
exactly which bytes are hashed.

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
