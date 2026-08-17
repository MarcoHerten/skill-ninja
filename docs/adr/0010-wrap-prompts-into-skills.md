# Prompt documents are wrapped into Skills

The second audited real-world sample is not a skill collection at all: a
300+-item Obsidian/Notion prompt-library export — raw "Du bist ein …" prompts,
no `SKILL.md` structure, ~72% without `name`/`description`, three frontmatter
generations mixed. `ingest` (ADR-0009) must still give these one unit, one
identity model, and one `status` view.

## Decision

The engine deterministically **wraps** each prompt document into a skill
package:

- `<normalized-stem>/SKILL.md`
- Frontmatter: `name` (the normalized stem), `provenance` + content hash
  (ADR-0005 stamps). Any frontmatter the document already carries (Notion
  fields, `tags`, `category`, …) is preserved verbatim — it is harmless YAML
  and keeps information.
- Body: the original prompt text under its own structure, untouched.
- `description`: **left empty**; the report marks the wrapped skill
  `needs-review`.

Descriptions are drafted **later**, in batched curation passes (agent proposes,
user approves) — never on ingest's critical path. A wrapped skill with an empty
description triggers nowhere until curated, which is acceptable because ingest
stores without linking (ADR-0009): nothing degrades until someone decides to
curate and use it.

Obsidian/Notion artifacts inside wrapped bodies (wiki-links, dead attachment
links, empty "Revisionen" stubs) are preserved as-is and never interpreted —
ingest is generic and carries no vault-specific logic.

## Considered Options

- **A second store type "Prompt"** — rejected: two identity models, two
  `status` semantics, and the wrap would be needed eventually anyway the
  moment a prompt should become usable. One type, one model.
- **Out of scope ("skills only")** — rejected: the messy prompt library is a
  primary real-world case for the target audience, not an edge case.
- **Agent drafts descriptions during the ingest walkthrough** — rejected:
  hundreds of drafts make `--apply` a blocker and exhaust the user; curation
  is a separate activity with its own rhythm.

## Consequences

- Name collisions between wrapped prompts and real skills resolve through the
  ordinary cluster rules (ADR-0009) — a wrapped prompt is just another
  candidate.
- Curation of the `needs-review` backlog becomes a first-class follow-up
  activity; where it lives (a doctor extension, a dedicated pass, or an ad-hoc
  agent session) is decided when it is built.
- Version-suffixed prompt files (`Anti-AI-Writing-v3/-v4/-v7`) cluster by
  their stripped stem and resolve by the version-signal rule — the newest
  becomes the skill, the others are reported losers.
