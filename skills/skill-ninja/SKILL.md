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
| `/skill-ninja doctor`| `doctor`        | Detect and repair problems (broken links, duplicates, orphans), each fix approved first. | **Live**      |
| `/skill-ninja add`   | `add`           | Ingest a new skill safely (safety check + diff), place + link it, stamp provenance & content hash. | **Live**      |
| `/skill-ninja diff`  | `diff`          | Compare a stored skill against a candidate (an updated copy or an upstream repo) and show what changed. | **Live**      |
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

### `/skill-ninja doctor` (live)

Runs `node <SKILL_DIR>/engine/cli.js doctor [options]` and relays the output. It detects problems across the **Skill** landscape, proposes a repair for each, and applies repairs **only with explicit approval** — nothing is changed by default. It reads the **cached inventory** written by `init` (it does **not** re-scan); the approval model, problem definitions, and repair rules are in `docs/adr/0006-doctor-detection-repair-and-approval.md`.

**Approval model — no silent changes:**

- `doctor` (no flag) — **detect + report**, a dry run. Every problem is listed in plain language with its proposed repair. The filesystem is **not modified**. Exit 0. This is the skill layer's moment to walk the user through each proposed repair.
- `doctor --apply` — the explicit approval. Every proposed repair is applied, then a **summary of applied changes** is printed. Exit 0.
- `doctor --only broken|duplicates|orphans` — scope which problem types are considered (reported, and — with `--apply` — repaired). Default: all.

**Problems detected:**

- **Broken links** — dangling symlinks recorded by `init` (in `inventory.broken[]`).
- **Duplicates** — a **Skill** spread across more than one location (**tool asymmetry**) *where at least one occurrence is a loose copy*. To tell a problematic duplicate from a healthy linked spread, `doctor` classifies each occurrence against the filesystem (read-only): **store** (under the canonical store), **link** (a symlink — the healthy state `add` produces), or **loose** (a real directory not under the store and not linked). A spread of all links is healthy and is **not** flagged.
- **Orphans** — a *solo* occurrence (its name appears once) that is a **loose** copy: a real skill floating in an **agent root** or **vault**, never ingested into the canonical store. (A loose copy that is part of a duplicate spread is owned by dedup, not orphan repair.)

**Repairs (on `--apply`):**

- **Broken link** → remove the dangling symlink.
- **Duplicate** → **consolidate to one canonical copy + links**, reusing `add`'s linking pattern: copy the chosen canonical content (prefer an occurrence under the store, else the first loose by path) into `<store>/<name>`, then replace each loose location with a symlink → `<store>/<name>`. Result: one canonical file, linked into the relevant roots — tool asymmetry resolved (one canonical copy + links, not multi-target deploy). The dry run names the canonical source so the user sees which content wins before approving.
- **Orphan** → ingest into `<store>/<name>` and link its original location → the store copy.

`doctor` copies verbatim; it does **not** re-stamp `version`/`hash`/`provenance` (that is `add`'s job). After `--apply`, re-run `init` then `doctor` to confirm a healthy landscape. The dedup/orphan features require a configured `config.store`; without one, only broken links are handled. If no inventory exists yet, `doctor` says so and points to `init` (exit 0).

### `/skill-ninja add` (live)

Runs `node <SKILL_DIR>/engine/cli.js add <source> [options]` and relays the output. It ingests a new **Skill** from a source, runs the **safety check**, shows a diff against any existing version, places the canonical copy in the **canonical store**, links it into the chosen **agent roots** (resolving **tool asymmetry**), stamps **version / provenance / content hash**, and commits if the store is a git repo. The engine is **non-interactive**: it reports safety findings and diffs to stdout and proceeds; this skill layer is where you walk the user through reviewing the safety output before running the install.

**Sources** (auto-detected):

- a **folder** — a directory containing `SKILL.md` (its sibling files are bundled assets, copied along). The primary path.
- a **bare file** — a single `SKILL.md` file path (pass `--name`).
- a **bare prompt** — `--prompt "<text>"` writes a SKILL.md from raw content (pass `--name`).
- a **repo/URL** — a git URL (`https://`, `git@`, `ssh://`), an `owner/repo` shorthand, or any path ending in `.git`; cloned via `git clone` into a temp dir, then treated as a folder.

**Options:**

- `--to claude,zcode` — comma-separated agent keys to link into (default: every configured agent). Each resolves to its **agent root**; the link is a symlink `<agent-root>/<name>` → `<store>/<name>`, so there is ONE canonical file available in every root.
- `--name <name>` — set the skill name (otherwise the incoming frontmatter `name`, or the source folder's basename).
- `--source authored|received|external` — the **provenance** origin. Default: `external` for a repo/URL, `received` otherwise.
- `--from <text>` — who/where it came from. Default: the source argument (or `prompt`).
- `--prompt "<text>"` — ingest raw content as the skill body (no source path).

**What it reports (stdout), in order:** the safety findings (see below); a diff if the skill name already exists in the store; then a summary — the stored path, the links created, the content hash, and whether it was committed.

**Safety check** — lightweight *static* pattern matching (not a sandbox) over the incoming `SKILL.md` and any bundled scripts, in three categories: **destructive** (`rm -rf`, `sudo`, `chmod 777`, `dd of=`, `mkfs`, fork bombs), **network** (`curl`, `wget`, `fetch(`, `http(s)://`, `ssh`, `scp`, `nc`, raw IPs), and **hidden/obfuscated** (`eval`, command substitution, backticks, `base64 --decode`, `/dev` redirects, secret/env references). Each finding is a plain-language sentence with the matched snippet and file, plus a summary line. The engine reports but never blocks; approval is the skill layer's job. The patterns live in `engine/safety.js` as a documented, extensible set (`doctor` will reuse it).

**Stamps written** to the stored `SKILL.md` frontmatter (the contract `diff` depends on, in `docs/adr/0005-stamping-and-content-hash.md`): `name`, `version` (new skill → `1.0.0`; changed re-add → PATCH bump; identical re-add → unchanged), `updated` (ISO date), `hash` (SHA-256 of the **body** — the content after the frontmatter block, so it changes only when the instructions change), and `provenance { source, from, imported, derived_from }`. On re-add, `derived_from` carries the prior content hash, linking versions.

**Git commit** — if the canonical store is a git repo (`git -C <store> rev-parse` succeeds), the new skill is staged and committed locally as `add skill <name>`; it is **not** pushed (pushing is a separate, manual step in v1). If the store is not a git repo, this step is skipped silently.

### `/skill-ninja diff` (live)

Runs `node <SKILL_DIR>/engine/cli.js diff <name> <candidate>` and relays the output. It answers "a friend sent v2 — what's new?" and "is an update available upstream?" by comparing a **Skill** already in the **canonical store** (the baseline) against a candidate version. The comparison is over the **body** (the instructions after the frontmatter, per ADR-0005), so stamping churn never shows up as a change.

**Usage:** `skill-ninja diff <name> <candidate>`

- `<name>` — a Skill already in the canonical store (the baseline / stored version).
- `<candidate>` — the version to compare: a **folder** (a directory with `SKILL.md`), a **bare `SKILL.md` file**, or a **repo/URL** (a git URL, `owner/repo` shorthand, or a path ending in `.git`). It is resolved with the *same* source resolver `add` uses, so a repo/URL candidate **is** the upstream/external version — Skill Ninja clones it and diffs the cloned `SKILL.md`.

**A candidate is required.** The store copy is the canonical baseline, so there is nothing to diff without a second version to compare it against. Run `diff <name>` with no candidate and Skill Ninja says so in plain language and shows the usage (exit non-zero).

**What it reports (stdout), in order:** a one-line header naming both sides — `diff '<name>': stored version <v> (hash ab12…) vs incoming <candidate> (hash cd34…) → content DIFFERS` (or `MATCHES`). Then:

- If the two bodies share a content hash → `No content changes; the incoming version matches the stored version.` Nothing else. Exit 0.
- If they differ → a one-line **summary** counting the changes distinctly — `Summary: N lines added, M lines removed, K lines changed.` — followed by a unified diff block with `-` (removed) and `+` (added) lines. A "changed" line is a removed line immediately followed by an added line (a modification); the rest are pure additions or removals. The counts come from the line diff, so they are exact, not approximate. Exit 0 (a successful diff — differences are information, not an error).

If `<name>` is not in the store, `diff` says so in plain language, names the store path, and points to `add` (exit non-zero). The content hashes are SHA-256 of each side's body; the header shows the first 8 hex characters of each.

### `/skill-ninja config` (live)

Runs `node <SKILL_DIR>/engine/cli.js config show` and relays the output. It prints the resolved **canonical store**, each configured **agent** with its resolved **agent root**, and the configured **vaults**. If no configuration exists yet, it says so and points to `init`.

## Build status

The skill → engine path, the **config** loader, the **agent-root model**, and the fixture test harness are in place. `init` (machine analysis + cached inventory), `status` (one readable inventory view with filters), `doctor` (detect problems, propose repairs, apply only on `--apply`, with a summary of applied changes), `add` (safe ingest with stamping, content hash, store placement + agent-root linking, safety check, existing-version diff, and git commit), `diff` (compare a stored skill against a candidate / upstream version, with a readable added-changed-removed summary), and `config` are live. The full v1.0 command surface is now implemented.
