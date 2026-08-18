# Availability layer: on / off / manual + per-purpose profiles

A user with hundreds of skills pays for every one of them in context: each
installed skill's name and description is presented to the agent in every
session, and a well-written description auto-triggers. There was no way to say
"this skill only when I ask for it by name" or "not at all right now", and no
way to give one repo a different skill set than another. Skill Ninja gains an
**Availability** layer (CONTEXT.md): three states per skill, bulk switching,
search, and **Profiles** — with the mechanism chosen per tier.

## Decision

### The three states

- **Active** (default) — linked in the agent roots, loaded, auto-triggered.
- **Manual** — still listed and invocable by name (`/ <skill-name>`), but never
  auto-triggered. For context cost this is nearly as good as Off (a placeholder
  description is one line) while keeping the skill one slash away — switching
  Off→On requires a session restart to take effect, Manual does not.
- **Off** — not loaded into any context anywhere.

### Mechanism is per tier (the hybrid)

- **Personal, Off** — unlink from every configured agent root **plus** an
  `availability: "off"` stamp on the stored copy. The store keeps the skill;
  `on` re-links it (this is also the long-deferred "bulk linking" command).
- **Personal, Manual** — links stay; on the stored copy the `description` moves
  into a new `activation_text` stamp and is replaced by the placeholder
  `"Manual skill — invoke explicitly by name."`, plus
  `disable-model-invocation: true` (honored by the Claude-Code family) and
  `availability: "manual"`. All frontmatter-only edits in the `cat assign`
  style: body, `version`, and the content hash never move (ADR-0005), no
  CHANGELOG entry — the store's git log (`availability …` commits) is the
  record. Switching back to Active restores the activation text verbatim.
- **External, Off** — a ZCode-only config disable: `skills: { "<absolute
  SKILL.md path>": { "enable": false } }` in `~/.zcode/cli/config.json`, one
  entry per root ZCode discovers the skill at. Never unlink (that would fight
  skills.sh's bookkeeping, ADR-0007), never stamp (no write access to
  skills.sh-owned files).
- **External, Manual** — **not supported.** The only cross-agent Manual
  mechanism is the description construction, which requires writing the stored
  copy — skills.sh owns it.

Why this construction for Manual: no agent except the Claude-Code family has a
native "listed but never auto-triggered" mode; ZCode's only lever is binary
(`enable: false` removes the skill entirely, slash-invocation included). But
the semantics "no description to match on → listed, invocable, silent" are
already blessed by ADR-0010 (a wrapped prompt with an empty description
"triggers nowhere until curated"). Manual generalizes that deliberately,
without losing the text: it is preserved in `activation_text` and restored on
return. ZCode ignores the unknown `activation_text` /
`disable-model-invocation` keys, so the construction is inert there.

### Intent is data on the skill, and the store is visible

The `availability` stamp on the stored copy is the record of intent
(the ADR-0013 philosophy — data on the skill, never a mapping in a script).
The ZCode-disable ledger for External skills lives in
`~/.skill-ninja/config.json` (`zcode_disables`) because External files are
unwritable; it records exactly which config entries Skill Ninja wrote so `on`
removes only its own and never the user's hand-set overrides.

`init` scans the **canonical store as its own scan root** (inventory schema
v4). Without it, an Off skill — unlinked everywhere — would vanish from every
view, and the user could not switch it back on. Consequences: stored skills
appear in `status`/`cat`/`page` even when linked nowhere (tagged
`[stored — not linked]`, e.g. `ingest` output that was never linked — honest,
it exists), and location counts grow by the store occurrence. A stored skill
is not a doctor orphan (orphan = solo *loose* copy; store occurrences never
qualify), so Off intent and doctor cannot collide.

### The commands

`ninja on | off | manual <selector>` with uniform selectors — name list,
`--category <c>`, `--tier personal`, `--except <names>`. Two-phase like
doctor/ingest: **dry run by default, `--apply` executes** (bulk Off can unlink
dozens of skills; that must never happen silently). The self-preservation
guard refuses to switch the `ninja` skill itself Off or Manual. Loose
unattributed copies (no stored copy, no skills.sh attribution) are refused
with a pointer to `add`/`doctor` — the stamp needs a stored copy to live on.
`add` on a skill that is currently Off or Manual is refused with a pointer to
`ninja on` first, so re-stamping can never silently drop `activation_text` or
re-link an Off skill. `find <term>` searches the cached inventory over name +
description + category (`cat <term>` filters categories only).

Availability changes take effect in **new** sessions — agents load skills at
session start; every apply summary says so.

### Profiles

`profiles: { "<name>": [<skill names>] }` in the config; managed via
`profile save | forget | list`. `profile apply <name>` runs in the project
directory and symlinks each member into `<cwd>/.agents/skills/<name>` →
`<store>/<name>` (the VetaSense pattern: project-local roots are discovered
per workspace, and a globally-Off skill exists *only* where a project links
it). `profile lift` removes exactly the links the profile owns — never a real
directory. **Additive**: a profile pulls its members into the project on top
of the global baseline; quiet comes from switching noise Off globally, not
from the profile restricting anything. Personal members only — an External
member is refused (re-enabling a ZCode-disabled External per-project would
rest on undocumented override-precedence). Composes with Manual: a project
link points at the same stored copy, so a Manual member stays Manual there.

## Considered Options

- **ZCode config disables for everything** — rejected: ZCode-only (the other
  13 roots keep loading the skill), and Manual is inexpressible in a binary
  enable flag.
- **Blanking the description permanently for Manual** — rejected: destroys the
  agent-activation text ADR-0005 promises to preserve; the
  `activation_text` stamp keeps the switch lossless.
- **`availability` stamps on External skills** — rejected: ADR-0007 (Skill
  Ninja never writes skills.sh-owned files).
- **Restrictive profiles** (the profile defines the *complete* active set in a
  project) — deferred: needs a blanket workspace-scope disable (huge override
  lists, undocumented precedence); the additive model covers the actual
  workflow ("these setups in this repo because I produce content here").
- **A local server page for bulk editing** — rejected: ADR-0011's local-first
  stance. The page stays one self-contained file; its inline JS only
  generates the `ninja … --apply` command to copy (ADR-0011 amendment).

## Consequences

- Inventory schema **v4**: occurrences carry `availability` (from the stored
  frontmatter; External occurrences get `off` overlaid from the ledger), and
  the store is a scan root. `status`/`page`/`find` show `[manual]`, `[off]`,
  and `[stored — not linked]` tags computed from the same rule (one home in
  `status.js`).
- `page` gains inline vanilla JS — search, availability/tier/category filters,
  checkbox selection generating a copyable command (ADR-0011 amendment).
- ZCode config edits are surgical: only the `skills` entries Skill Ninja
  wrote (tracked in the ledger) are ever added or removed; the file's other
  contents are preserved byte-for-byte around them.
- `on` on a stored-but-never-linked skill (e.g. an `ingest` winner) links it
  everywhere — availability is also the install-on-demand command.
