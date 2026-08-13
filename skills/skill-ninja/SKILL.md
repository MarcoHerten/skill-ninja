---
name: skill-ninja
description: Manage the skills AI coding agents consume — analyze the machine, inventory every skill across agent roots and vaults, repair the mess, and ingest new skills safely with provenance. Drives a bundled Node engine.
---

# Skill Ninja

A standalone **skill**-management product. This `SKILL.md` is the **interface layer** the agent drives via slash commands; the deterministic work (inventory, hash, diff, doctor) is done by the **Node engine** bundled alongside it. The skill is the interface; the engine is the muscle.

> Vocabulary: `Skill`, `Provenance`, `Agent root`, `Tool asymmetry`, the tiers (`Personal` / `External` / `Project` / `Plugin`), and the **canonical store** are defined in the repo's [`CONTEXT.md`](../../../CONTEXT.md). Use those terms.

## How it works — the engine

The engine lives next to this `SKILL.md` at `engine/cli.js`. Run it with:

```
node <SKILL_DIR>/engine/cli.js <command> [args]
```

where `<SKILL_DIR>` is the directory that contains this `SKILL.md`. Always run a command through the engine and relay its stdout back to the user — the engine is the source of truth for every result; this skill only routes and frames.

Because of **tool asymmetry**, Skill Ninja resolves each **agent root** (e.g. `~/.claude/skills`, `~/.zcode/skills`, `~/.agents/skills`) under the user's `$HOME`, so the same logical **Skill** can live in every root a user's agents read. Configuration — the **canonical store** path, which agents and **vaults** to scan — lives at `~/.skill-ninja/config.json`.

## Slash commands

| Slash command        | Engine command  | What it does                                                                | Status        |
| -------------------- | --------------- | --------------------------------------------------------------------------- | ------------- |
| `/skill-ninja init`  | `init`          | Analyze the machine; scan agent roots, vaults, and project dirs, write the cached inventory. | **Live**      |
| `/skill-ninja status`| `status`        | One inventory view: every skill's location, duplicates, broken links, versions, provenance. | **Live**      |
| `/skill-ninja doctor`| `doctor`        | Detect and repair problems (broken links, duplicates, orphans), each fix approved first. | Not yet built |
| `/skill-ninja add`   | `add`           | Ingest a new skill safely (safety check + diff), install it, record provenance. | Not yet built |
| `/skill-ninja diff`  | `diff`          | Show what changed in a skill since the stored version.                      | Not yet built |
| `/skill-ninja config`| `config show`   | Print the loaded configuration (canonical store, agent roots, vaults, projects). | **Live**      |

### `/skill-ninja init` (live)

Runs `node <SKILL_DIR>/engine/cli.js init` and relays the output. It scans every configured **scope** — the **agent roots** for each configured agent (tool asymmetry abstracted), the **vaults**, and the **project** working directories — and discovers every **Skill** (a `SKILL.md`, found by descent; a directory holding one is recorded and not descended into, since its subdirs are bundled assets). For each skill it records its location and scope, and parses `version` / `updated` / `provenance` from the `SKILL.md` frontmatter where present (absent fields are `null`). Broken symlinks are recorded distinctly rather than dropped.

The result is written as a **cached inventory** at `~/.skill-ninja/inventory.json` — the data layer the other commands will read. The command prints a short summary (skills found, per-scope counts, broken-symlink count, cache path). Running it again overwrites the cache with a fresh scan (idempotent). The inventory schema and discovery rule are documented in `docs/adr/0003-cached-inventory-and-discovery.md`.

### `/skill-ninja status` (live)

Runs `node <SKILL_DIR>/engine/cli.js status [filters]` and relays the output. It reads the **cached inventory** written by `init` (it does **not** re-scan) and presents one unified, plain-language view: every **Skill** once, with each **location** it lives in and a human label for its scope (e.g. `Claude root`, `ZCode root`, `vault <path>`, `project <path>`). For each location it shows `version` and **provenance** where known (`unknown` where not). Skills present in more than one location — the visible symptom of **tool asymmetry** — are tagged `[duplicate]` and list every location. **Broken symlinks** are listed distinctly under their own heading with a `[broken symlink]` marker. A header summarises the totals (skills, locations, duplicated skills, broken symlinks).

Filters narrow the view and may combine:

- `--broken` — only broken symlinks (skills hidden).
- `--duplicates` — only skills with more than one location.
- `--personal` — only **Personal** skills. A skill is Personal when it lives under the configured **canonical store** path **or** its `provenance.source` is `authored` (the documented heuristic in `docs/adr/0004-personal-tier-heuristic.md`).

Skill filters combine with AND; adding `--broken` alongside a skill filter shows both the matching skills and the broken symlinks. With no filter, the full unified view is shown. If no inventory exists yet, `status` says so in plain language and points to `init` (exit 0).

### `/skill-ninja config` (live)

Runs `node <SKILL_DIR>/engine/cli.js config show` and relays the output. It prints the resolved **canonical store**, each configured **agent** with its resolved **agent root**, and the configured **vaults**. If no configuration exists yet, it says so and points to `init`.

## Build status

The skill → engine path, the **config** loader, the **agent-root model**, and the fixture test harness are in place. `init` (machine analysis + cached inventory), `status` (one readable inventory view with filters), and `config` are live. The `doctor` / `add` / `diff` commands are the intended surface and are reported as "not implemented in this build yet" by the engine until their tickets land.
