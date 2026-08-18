---
name: ninja
description: Manage the skills AI coding agents consume — analyze the machine, inventory every skill across agent roots and vaults, repair the mess, and ingest new skills safely with provenance. Drives a bundled Node engine.
version: 1.2.0
updated: 2026-08-18
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

Because of **tool asymmetry**, Skill Ninja resolves each **agent root** (e.g. `~/.claude/skills`, `~/.zcode/skills`, `~/.agents/skills`) under the user's `$HOME`, so the same logical **Skill** can live in every root a user's agents read. Configuration — the **canonical store** path, which agents and **vaults** to scan — lives at `~/.skill-ninja/config.json`. **`init` creates this file for you** (ADR-0008): it probes for installed agents, reads Obsidian's vault registry, seeds the config, creates the store, then scans. (Installation itself is skills.sh's job — ADR-0007.)

## Slash commands

| Slash command        | Engine command  | What it does                                                                | Status        |
| -------------------- | --------------- | --------------------------------------------------------------------------- | ------------- |
| `/ninja init`  | `init`          | Analyze the machine; scan agent roots, vaults, and project dirs, write the cached inventory. | **Live**      |
| `/ninja status`| `status`        | One inventory view: every skill's location, duplicates, broken links, versions, provenance. | **Live**      |
| `/ninja cat`   | `cat`           | Browse the landscape as a catalog grouped by category; `cat assign` stamps a category on the stored copy. | **Live (v1.2)** |
| `/ninja page`  | `page`          | Render the cached inventory as a self-contained static HTML status page and print its path. | **Live (v1.1)** |
| `/ninja doctor`| `doctor`        | Detect and repair problems (broken links, duplicates, orphans), each fix approved first. | **Live**      |
| `/ninja add`   | `add`           | Ingest a new skill safely (safety check + diff), place + link it, stamp provenance & content hash, write its CHANGELOG.md. | **Live**      |
| `/ninja ingest`| `ingest`        | Bulk-analyze a messy source directory (skills in any packaging, prompt documents), report the proposed resolution, and on `--apply` store the winners with provenance — read-only on the source, links nothing. | **Live (v1.1)** |
| `/ninja diff`  | `diff`          | Compare a stored skill against a candidate (an updated copy or an upstream repo) and show what changed. | **Live**      |
| `/ninja config`| `config show`   | Print the loaded configuration (canonical store, agent roots, vaults, projects). | **Live**      |

### `/ninja init` (live)

Runs `node <SKILL_DIR>/engine/cli.js init` and relays the output. On a fresh machine it needs **no pre-existing config** — it discovers the landscape, seeds `~/.skill-ninja/config.json`, creates the canonical store (+ `git init`), then scans (ADR-0008). It scans every configured **scan root** — the **agent roots** for each detected agent (existence-probe over skills.sh's conventions; tool asymmetry abstracted), the Obsidian **vaults** (read from `obsidian.json`), and the **project** working directories — and discovers every **Skill** (a `SKILL.md`, found by descent; a directory holding one is recorded and not descended into, since its subdirs are bundled assets). For each skill it records its location and scan root, and parses `version` / `updated` / `provenance` from the `SKILL.md` frontmatter where present (absent fields are `null`). It also reads skills.sh's `skills-lock.json` (the global one at `~/skills-lock.json`, plus any per scan root) to attribute skills to their source. Broken symlinks are recorded distinctly rather than dropped.

The result is written as a **cached inventory** at `~/.skill-ninja/inventory.json` — the data layer the other commands read. The command prints a short summary (skills found, per-scan-root counts, broken-symlink count, cache path). Running it again re-discovers, re-seeds the config, and overwrites the cache with a fresh scan (idempotent — this is also how you refresh or edit config). The inventory schema and discovery rule are documented in `docs/adr/0003-cached-inventory-and-discovery.md`; the bootstrap in `docs/adr/0008-init-bootstraps-config-and-discovers.md`. Schema v3 (ADR-0013) additionally captures each skill's `category` and `description` frontmatter where present (absent → `null`) — the data `cat` and the page's catalog grouping read.

### `/ninja status` (live)

Runs `node <SKILL_DIR>/engine/cli.js status [filters]` and relays the output. It reads the **cached inventory** written by `init` (it does **not** re-scan) and presents one unified, plain-language view: every **Skill** once, with each **location** it lives in and a human label for its scan root (e.g. `Claude root`, `ZCode root`, `vault <path>`, `project <path>`). For each location it shows `version` and **provenance** where known (`unknown` where not); a symlink location also shows its resolved target (`→ <path>`). A Skill in more than one location — the visible symptom of **tool asymmetry** — is tagged by *how* it is spread: `[linked spread]` when every location resolves to one canonical copy (symlink awareness, inventory schema v2 — `add`'s store links and skills.sh's install pattern alike: one real directory plus links into it), which is the healthy state and not a problem; `[duplicate]` only when independent copies exist. The same content under a *different* name — caught by the **content hash** — is tagged `[duplicate — same content, other name]`. Skills installed by skills.sh (attributed from its `skills-lock.json`) are shown as **External** with their source. **Broken symlinks** are listed distinctly under their own heading with a `[broken symlink]` marker. A header summarises the totals (skills, locations, duplicated skills — linked spreads not counted — broken symlinks).

Filters narrow the view and may combine:

- `--broken` — only broken symlinks (skills hidden).
- `--duplicates` — only duplicates (by name or by identical content). Healthy linked spreads are excluded — they are not problems.
- `--personal` — only **Personal** skills (External skills are excluded). A skill is Personal when it lives under the configured **canonical store** path **or** its `provenance.source` is `authored` (the documented heuristic in `docs/adr/0004-personal-tier-heuristic.md`).

Skill filters combine with AND; adding `--broken` alongside a skill filter shows both the matching skills and the broken symlinks. With no filter, the full unified view is shown. If no inventory exists yet, `status` says so in plain language and points to `init` (exit 0).

### `/ninja cat` (live, v1.2)

Runs `node <SKILL_DIR>/engine/cli.js cat [category]` (catalog view) or `cat assign <name> <category>` (stamp write) and relays the output. Categories are **data on the skill**, not a mapping in a script (ADR-0013): each stored skill carries a `category` frontmatter stamp, `init` captures it (plus the skill's `description`) into the cached inventory (schema v3), and the catalog is a **view over that cache** — computed on demand, never a second artifact to keep in sync.

- `cat [category]` — the catalog: every **Skill** once, grouped under category headings (the vocabulary's order first, then custom categories, **Uncategorized** last — the backlog stays visible), each entry `name [Personal/External tier] — description`. The header counts skills, categories, and uncategorized. A term filters to categories whose name contains it (case-insensitive); a term matching nothing lists the categories present. Reads the cached inventory (re-run `init` after assigning to refresh). No inventory yet → plain-language hint pointing to `init` (exit 0).
- `cat assign <name> <category>` — stamp the category onto the **stored copy** in the canonical store: a frontmatter-only edit (the body, `version`, `updated`, and the content hash are untouched, so `diff` never reports a categorization as a content change, and there is no CHANGELOG entry), committed as `categorize <name>` and pushed when a remote is configured. Re-assigning the same category is a no-op; replacing it swaps the line. Only stored skills are writable — a loose copy or an unknown name is refused with a pointer to `add`, and **External** (skills.sh-owned) skills are never rewritten (ADR-0007).

**Which category fits is this skill layer's job** (ADR-0013): the engine validates and writes, it never guesses. When the user wants a skill categorized, read its name + description (and body if needed), propose a category **from the vocabulary** — the engine defaults are Strategy & Management, Marketing & Social, Content & Writing, Design & Documents, Education & Specialties, Meta & Agent Tooling; the config's `categories: [...]` replaces that list — and, on the user's approval, run `cat assign`. A value outside the vocabulary only draws a warning (free-form categories render as their own group); surface that warning rather than silently inventing new taxonomy entries. Offering categorization during `add`/`ingest` approval walks follows the same pattern: propose, get approval, assign.

### `/ninja page` (live, v1.1)

Runs `node <SKILL_DIR>/engine/cli.js page` and relays the output. It renders the **cached inventory** (written by `init`; it does **not** re-scan) as **one self-contained static HTML file** — inline CSS, no server, no scripts, no external assets, no network (ADR-0011) — writes it to `~/.skill-ninja/status.html`, and prints the path plus the same totals the `status` header shows. The page is the browser counterpart of `ninja status` **and the catalog**: its skills section groups by category with the *same code* `cat` uses (vocabulary order, **Uncategorized** last; ADR-0013), each skill showing its description under the name. Per **Skill** the name carries a Personal/External tier badge and the same spread tags (`[linked spread]` / `[duplicate]` / `[duplicate — same content, other name]`), each location with its scan-root label, `symlink → resolved target`, `version` / **provenance**, plus a broken-symlinks section and the summary header. The grouping and tagging logic is the *same code* `status` uses, so the views cannot disagree.

The file is **regenerated wholesale on every invocation** — there is no watcher and no auto-refresh. After changing the landscape, run `/ninja init` then `/ninja page` to refresh the view. The command is read-only towards the skill landscape: it writes exactly the one HTML file. Relay the printed path to the user and open it in their browser (e.g. `open <path>` on macOS); the page works offline via `file://`. If no inventory exists yet, `page` says so in plain language and points to `init` (exit 0). The page contains landscape metadata (names, paths, provenance) — treat the file as local, private data; Skill Ninja never publishes it.

### `/ninja doctor` (live)

Runs `node <SKILL_DIR>/engine/cli.js doctor [options]` and relays the output. It detects problems across the **Skill** landscape, proposes a repair for each, and applies repairs **only with explicit approval** — nothing is changed by default. It reads the **cached inventory** written by `init` (it does **not** re-scan); the approval model, problem definitions, and repair rules are in `docs/adr/0006-doctor-detection-repair-and-approval.md`.

**Approval model — no silent changes:**

- `doctor` (no flag) — **detect + report**, a dry run. Every problem is listed in plain language with its proposed repair. The filesystem is **not modified**. Exit 0. This is the skill layer's moment to walk the user through each proposed repair.
- `doctor --apply` — the explicit approval. Every proposed repair is applied, then a **summary of applied changes** is printed. Exit 0.
- `doctor --only broken|duplicates|orphans` — scope which problem types are considered (reported, and — with `--apply` — repaired). Default: all.

**Problems detected:**

- **Broken links** — dangling symlinks recorded by `init` (in `inventory.broken[]`).
- **Duplicates** — a **Skill** spread across more than one location (**tool asymmetry**) where the spread resolves to **two or more independent content locations** (`realpath` per occurrence). A spread that resolves to **one** canonical copy is healthy and is **not** flagged — that covers `add`'s links into the canonical store *and* skills.sh's install pattern (one real directory in an agent root, the other roots symlinked into it). To classify, `doctor` inspects each occurrence against the filesystem (read-only): **store** (under the canonical store), **link** (a symlink), or **loose** (a real directory not under the store and not linked). **External** skills (attributed to skills.sh via its lockfile) are **never** proposed for consolidation or orphan repair — Skill Ninja audits them but does not re-link them (ADR-0007).
- **Orphans** — a *solo* occurrence (its name appears once) that is a **loose** copy: a real skill floating in an **agent root** or **vault**, never ingested into the canonical store. (A loose copy that is part of a duplicate spread is owned by dedup, not orphan repair.)

**Repairs (on `--apply`):**

- **Broken link** → remove the dangling symlink.
- **Duplicate** → **consolidate to one canonical copy + links**, reusing `add`'s linking pattern: copy the chosen canonical content (prefer an occurrence under the store, else the first loose by path) into `<store>/<name>`, then replace each loose location with a symlink → `<store>/<name>`. Result: one canonical file, linked into the relevant roots — tool asymmetry resolved (one canonical copy + links, not multi-target deploy). The dry run names the canonical source so the user sees which content wins before approving.
- **Orphan** → ingest into `<store>/<name>` and link its original location → the store copy.

`doctor` copies verbatim; it does **not** re-stamp `version`/`hash`/`provenance` (that is `add`'s job). After `--apply`, re-run `init` then `doctor` to confirm a healthy landscape. The dedup/orphan features require a configured `config.store`; without one, only broken links are handled. If no inventory exists yet, `doctor` says so and points to `init` (exit 0).

### `/ninja add` (live)

Runs `node <SKILL_DIR>/engine/cli.js add <source> [options]` and relays the output. This is the path for skills that **didn't come through skills.sh** (received, downloaded, or a bare prompt) — installing skills.sh-sourced skills is `npx skills add`'s job (ADR-0007). It runs the **safety check**, shows a diff against any existing version, places the canonical copy in the **canonical store**, links it into the chosen **agent roots** (resolving **tool asymmetry**), stamps **version / provenance / content hash**, and commits **and pushes** to the private remote (commit-only if no remote is configured). The engine is **non-interactive**: it reports safety findings and diffs to stdout and proceeds; this skill layer is where you walk the user through reviewing the safety output before running the ingest.

**Sources** (auto-detected):

- a **folder** — a directory containing `SKILL.md` (its sibling files are bundled assets, copied along). The primary path.
- a **zip archive** — a `.zip` path (how a friend typically sends a skill); extracted to a temp dir, then treated as a folder — the archive root or its single wrapping directory must hold the `SKILL.md`.
- a **bare file** — a single `SKILL.md` file path (pass `--name`).
- a **bare prompt** — `--prompt "<text>"` writes a SKILL.md from raw content (pass `--name`).
- a **repo/URL** — a git URL (`https://`, `git@`, `ssh://`), an `owner/repo` shorthand, or any path ending in `.git`; cloned via `git clone` into a temp dir, then treated as a folder.

**Options:**

- `--to claude,zcode` — comma-separated agent keys to link into (default: every configured agent). Each resolves to its **agent root**; the link is a symlink `<agent-root>/<name>` → `<store>/<name>`, so there is ONE canonical file available in every root.
- `--name <name>` — set the skill name (otherwise the incoming frontmatter `name`, or the source folder's basename).
- `--source authored|received|external` — the **provenance** origin. Default: `external` for a repo/URL, `received` otherwise.
- `--from <text>` — who/where it came from. Default: the source argument (or `prompt`).
- `--relation "<text>"` — the relationship to a **comparable skill** (e.g. `"A/B variant of <name>"`, `"replaces <name>"`, `"further development of framework <X>"`). Recorded as `provenance.relation`; on re-add without `--relation`, an existing relation carries forward rather than being dropped.
- `--prompt "<text>"` — ingest raw content as the skill body (no source path).

**What it reports (stdout), in order:** the safety findings (see below); a diff if the skill name already exists in the store; the **comparable-skills** list (see the intake review below); then a summary — the stored path, the links created, the content hash, and whether it was committed (+ pushed).

**Intake review — comparable skills & integrity checks** (ported from the proven `skill-intake` workflow): before anything is kept twice, `add` surfaces store skills that are **comparable** — the same family under a different name — detected deterministically by shared **name stems**, overlapping **description keywords**, or **identical content**. The exact-name case is the diff shown above, not this list. When the engine lists comparables, this skill layer walks the user through a **comparison report** using the bundled template at `references/comparison-report.md`: a facts table (size, structure, trigger breadth, maintenance), a content comparison with concrete examples, three **integrity checks** — **trigger collisions** (both descriptions claiming the same requests without delimitation), **dangling references** (the skill naming skills that exist in no agent root), and **variant integrity** (an A/B variant must still represent its source; version/provenance must make clear which state is older) — ending in a recommendation: **replace · keep parallel · merge · reject**. Resolve conflicts *before* ingesting (sharpen the description, fix or drop dangling references, stamp `--relation`), and let the user decide. The engine only reports — the decision is the user's.

**Safety check** — lightweight *static* pattern matching (not a sandbox) over the incoming `SKILL.md` and any bundled scripts, in three categories: **destructive** (`rm -rf`, `sudo`, `chmod 777`, `dd of=`, `mkfs`, fork bombs), **network** (`curl`, `wget`, `fetch(`, `http(s)://`, `ssh`, `scp`, `nc`, raw IPs), and **hidden/obfuscated** (`eval`, command substitution, backticks, `base64 --decode`, `/dev` redirects, secret/env references). Each finding is a plain-language sentence with the matched snippet and file, plus a summary line. The engine reports but never blocks; approval is the skill layer's job. The patterns live in `engine/safety.js` as a documented, extensible set (`doctor` will reuse it).

**Stamps written** to the stored `SKILL.md` frontmatter (the contract `diff` depends on, in `docs/adr/0005-stamping-and-content-hash.md`): `name`, `version` (new skill → `1.0.0`; changed re-add → PATCH bump; identical re-add → unchanged), `updated` (ISO date), `hash` (SHA-256 of the **body** — the content after the frontmatter block, so it changes only when the instructions change), and `provenance { source, from, imported, derived_from, relation }`. On re-add, `derived_from` carries the prior content hash, linking versions; `relation` (see `--relation`) carries forward unless replaced; a `category` stamp (ADR-0013) survives re-adds the same way — the incoming category wins, else the prior stored one carries forward.

**Changelog** — the stamps' human-readable projection: a `CHANGELOG.md` next to the stored `SKILL.md` (ADR-0012), written by a shared engine writer. A new skill gets a header and a `v1.0.0 (<date>)` first entry recording the provenance origin and `--relation` when set. A changed re-add (the PATCH bump) appends a version entry with the same added/removed/changed counts `diff` reports, the superseded prior hash, and the relation stamped for that version; an identical re-add touches nothing. A skill stored before the changelog feature gets its file bootstrapped on the first changed re-add, opened with a note that earlier history lives in the store's git log — nothing is retro-fabricated. An incoming skill that already carries its own `CHANGELOG.md` keeps that content verbatim beneath the generated header (its own heading line is replaced, a maintenance-notes section survives updates untouched) — the engine never drafts editorial prose. The store owns the file: it is excluded from plain asset copying, and it travels in the same git commit as the skill.

**Git commit + push** — the canonical store is a git repo (`init` runs `git init`); the new skill is staged, committed as `add skill <name>`, and **pushed** to the configured private remote. If no remote is configured, it commits locally and skips push silently (ADR-0007).

### `/ninja ingest` (live, v1.1)

Specified in `docs/adr/0009-bulk-ingest-pipeline.md` and `docs/adr/0010-wrap-prompts-into-skills.md`. Runs `node <SKILL_DIR>/engine/cli.js ingest <dir> [--apply]` and relays the output. It is the **bulk** path for messy source directories — the export with the same skill as folder, `.zip`, `.skill`, *and* `.skill.zip`; the prompt library that was never skills at all. `add` stays the curated single-skill path. The pipeline is two-phase like `doctor`: a read-only dry run, then `--apply`. The dry run classifies every item (skill package / prompt document / junk, each with a reason, normalized identities), renders per prompt candidate the **exact wrap preview** (ADR-0010) — the wrapped skill's name and the `SKILL.md` `--apply` would store: ADR-0005 stamps, the document's own frontmatter verbatim, body byte-preserved, `description` never drafted (needs-review until curated) — and resolves **clusters** (ADR-0009): candidates group by normalized identity, one winner per cluster is proposed deterministically — byte-identical members collapse by content hash (ADR-0005) with the unpacked form winning among identical copies (folder > loose file > archive), while divergent content is ordered by explicit version signal (`v3` < `v4`, semver compared numerically, ISO/German/compact date codes; filename signals only — never mtime, and never frontmatter stamps, since `add` stamps every skill `1.0.0` and a stamp is no evidence of recency) — every loser is listed with its hash and the reason it lost, and the static safety check runs across all candidates as a per-line column (SKILL.md + bundled assets / archive members / prompt text).

- `ingest <dir>` — **analyze + report**, a dry run (the filesystem is not modified). Every item classifies as a **skill package** (any packaging; `SKILL.md` at any nesting level or under non-standard names like `SKILL-UPDATED.md`; archives detected by magic bytes, not extension), a **prompt document** (wrapped into a skill: name from the normalized filename, original text and frontmatter preserved, `description` never drafted — a description the document itself carries survives — + `needs-review`), or **junk** (skipped + reported, never deleted; assets *inside* a recognized package always travel). Variants cluster by normalized `name`; the report proposes one winner per cluster with a reason — byte-identical members collapse, the folder beats the archive among identical copies, an explicit version signal orders divergent content (never mtime — export mtimes are useless) — and lists losers with their hashes, junk, and the safety column. **Divergent duplicates** (same identity, different content, no version signal — or incomparable ones, a date against a `v3`) are marked `needs-decision` with a side-by-side the engine prepares (per-variant hash, line count, members, diff stats vs the first variant, a first-change hint); this skill layer walks the user through them and proposes batch resolutions to approve once per cluster group.
- `ingest <dir> --apply` — execute the approved batch: every winner is stored in the **canonical store** as `<store>/<identity>/SKILL.md` with ADR-0005 stamps — `provenance.from` labels the batch (the directory's basename), `derived_from` records the superseded variants' content hashes, the skill's own frontmatter (e.g. its `description`) survives stamping, and bundled assets travel with their winner (an archive winner's assets unpack from its package root). Each winner also gets its `CHANGELOG.md` (ADR-0012): a first entry naming the batch and the superseded lineage, with a carried-in author changelog preserved as the preamble — wrapped prompt-document winners included. The whole run lands as **exactly one commit** (message names the batch and the counts), **pushed** to the private remote when one is configured — commit-only otherwise, and no commit at all when nothing new was stored. Read-only on the source; nothing is linked into agent roots — linking stays an explicit later choice. Unresolved `needs-decision` clusters are **never auto-decided**: apply skips them and lists them in its summary (stored winners, skipped conflicts, already-stored skills, discarded losers, junk count). Re-ingesting the same directory is idempotent by identity + content hash: unchanged winners are marked/skipped as **already stored** (their changelogs untouched), and a changed winner becomes a `needs-decision` against the stored copy (the side-by-side includes it with a diff) — replacing stored content is the user's call, never a rule's.

**Approval flow:** run the dry run, walk the user through the report (winners, losers, junk, safety findings, needs-decision side-by-sides; propose batch resolutions for the conflicts), then — on the user's approval — re-run with `--apply` and relay the applied summary.

### `/ninja diff` (live)

Runs `node <SKILL_DIR>/engine/cli.js diff <name> <candidate>` and relays the output. It answers "a friend sent v2 — what's new?" and "is an update available upstream?" by comparing a **Skill** already in the **canonical store** (the baseline) against a candidate version. The comparison is over the **body** (the instructions after the frontmatter, per ADR-0005), so stamping churn never shows up as a change.

**Usage:** `ninja diff <name> <candidate>`

- `<name>` — a Skill already in the canonical store (the baseline / stored version).
- `<candidate>` — the version to compare: a **folder** (a directory with `SKILL.md`), a **bare `SKILL.md` file**, or a **repo/URL** (a git URL, `owner/repo` shorthand, or a path ending in `.git`). It is resolved with the *same* source resolver `add` uses, so a repo/URL candidate **is** the upstream/external version — Skill Ninja clones it and diffs the cloned `SKILL.md`.

**A candidate is required.** The store copy is the canonical baseline, so there is nothing to diff without a second version to compare it against. Run `diff <name>` with no candidate and Skill Ninja says so in plain language and shows the usage (exit non-zero).

**What it reports (stdout), in order:** a one-line header naming both sides — `diff '<name>': stored version <v> (hash ab12…) vs incoming <candidate> (hash cd34…) → content DIFFERS` (or `MATCHES`). Then:

- If the two bodies share a content hash → `No content changes; the incoming version matches the stored version.` Nothing else. Exit 0.
- If they differ → a one-line **summary** counting the changes distinctly — `Summary: N lines added, M lines removed, K lines changed.` — followed by a unified diff block with `-` (removed) and `+` (added) lines. A "changed" line is a removed line immediately followed by an added line (a modification); the rest are pure additions or removals. The counts come from the line diff, so they are exact, not approximate. Exit 0 (a successful diff — differences are information, not an error).

If `<name>` is not in the store, `diff` says so in plain language, names the store path, and points to `add` (exit non-zero). The content hashes are SHA-256 of each side's body; the header shows the first 8 hex characters of each.

### `/ninja config` (live)

Runs `node <SKILL_DIR>/engine/cli.js config show` and relays the output. It prints the resolved **canonical store**, each configured **agent** with its resolved **agent root**, and the configured **vaults**. If no configuration exists yet, it says so and points to `init`.

## Build status

The skill → engine path, the **config** loader, the **agent-root model**, and the fixture test harness are in place. `init` (machine analysis + cached inventory, bootstrapping config + store on a fresh machine per ADR-0008), `status` (one readable inventory view with filters, including content-hash duplicate detection and skills.sh External attribution), `doctor` (detect problems, propose repairs, apply only on `--apply`, with a summary of applied changes), `add` (safe ingest with stamping, content hash, store placement + agent-root linking, safety check, existing-version diff, and git commit + push per ADR-0007), `diff` (compare a stored skill against a candidate / upstream version, with a readable added-changed-removed summary), and `config` are live. The full v1.0 command surface is implemented and the engine has been realigned to the skills.sh-delegation architecture (ADR-0007) and `init`-bootstraps-config (ADR-0008). The v1.1 `ingest` pipeline (ADR-0009/0010) is live end to end — dry-run classification, prompt wrap previews, cluster resolution (winners / losers / needs-decision with side-by-sides), the safety column, and `--apply` (store the winners with provenance in one commit, idempotent re-ingest) — and the v1.1 static HTML status page (`page`, ADR-0011: self-contained file, regenerated per run, same grouping as `status`) is live. The v1.2 category catalog (`cat` view + `cat assign` stamps, inventory schema v3, page regrouping — ADR-0013) is live.
