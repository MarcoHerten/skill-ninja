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
| `/skill-ninja status`| `status`        | One inventory view: every skill's location, duplicates, broken links, versions, provenance. | Not yet built |
| `/skill-ninja doctor`| `doctor`        | Detect and repair problems (broken links, duplicates, orphans), each fix approved first. | Not yet built |
| `/skill-ninja add`   | `add`           | Ingest a new skill safely (safety check + diff), install it, record provenance. | Not yet built |
| `/skill-ninja diff`  | `diff`          | Show what changed in a skill since the stored version.                      | Not yet built |
| `/skill-ninja config`| `config show`   | Print the loaded configuration (canonical store, agent roots, vaults, projects). | **Live**      |

### `/skill-ninja init` (live)

Runs `node <SKILL_DIR>/engine/cli.js init` and relays the output. It scans every configured **scope** — the **agent roots** for each configured agent (tool asymmetry abstracted), the **vaults**, and the **project** working directories — and discovers every **Skill** (a `SKILL.md`, found by descent; a directory holding one is recorded and not descended into, since its subdirs are bundled assets). For each skill it records its location and scope, and parses `version` / `updated` / `provenance` from the `SKILL.md` frontmatter where present (absent fields are `null`). Broken symlinks are recorded distinctly rather than dropped.

The result is written as a **cached inventory** at `~/.skill-ninja/inventory.json` — the data layer the other commands will read. The command prints a short summary (skills found, per-scope counts, broken-symlink count, cache path). Running it again overwrites the cache with a fresh scan (idempotent). The inventory schema and discovery rule are documented in `docs/adr/0003-cached-inventory-and-discovery.md`.

### `/skill-ninja config` (live)

Runs `node <SKILL_DIR>/engine/cli.js config show` and relays the output. It prints the resolved **canonical store**, each configured **agent** with its resolved **agent root**, and the configured **vaults**. If no configuration exists yet, it says so and points to `init`.

## Build status

The skill → engine path, the **config** loader, the **agent-root model**, and the fixture test harness are in place. `init` (machine analysis + cached inventory) and `config` are live. The `status` / `doctor` / `add` / `diff` commands are the intended surface and are reported as "not implemented in this build yet" by the engine until their tickets land.
