# Skill Ninja — v1.1 Specification

> Vocabulary: see [`CONTEXT.md`](./CONTEXT.md) (Skill, Skill Ninja, Provenance, the tiers, Agent root, Tool asymmetry; Ingest, Candidate, Cluster, Wrap).
> Status: v1.0 command surface implemented and realigned to the sharpened architecture — installation delegated to skills.sh (ADR-0007), `init` bootstraps configuration (ADR-0008). v1.1 adds bulk `ingest` — specified (ADR-0009, ADR-0010); build underway: dry-run classification, prompt wrap previews, and cluster resolution (winners / losers / needs-decision with side-by-side, safety column) are live, `--apply` follows. The skill is invoked as `/ninja` (e.g. `/ninja init`).

## Problem Statement

Skills — the instruction files AI coding agents (Claude Code, Codex, Cursor, …) consume — are chaos, especially for non-expert users. They end up scattered across multiple agents' skill directories and Obsidian vaults: sometimes global, sometimes per-project, sometimes symlinked, often buried where agents can't reach them. Users cannot see what is where, spot duplicates or broken symlinks, track versions, or tell what changed when a collaborator sends an updated skill weeks later.

Existing approaches are either ad-hoc (a hand-managed folder of symlinks) or overloaded multi-tool orchestrations. There is no single, easy tool that gives a non-expert a clear picture of their skill landscape and lets them safely add, repair, and version skills across all of their agents.

## Solution

**Skill Ninja** — a standalone skill-management product, installed (like any skill) via skills.sh: `npx skills add MarcoHerten/skill-ninja`. **skills.sh is the installer**; Skill Ninja is the layer on top — it audits the skills already on the machine, heals them, and ingests (with provenance) the skills that don't come through skills.sh. It runs inside the coding agent and provides six capabilities:

- **`init`** — analyzes the machine: which coding agents are installed, and where every skill lives across agent roots and Obsidian vaults.
- **`status`** — one inventory view: each skill's location, duplicates, broken symlinks, versions, and provenance.
- **`doctor`** — detects and repairs problems (broken links, duplicates, orphans), applying each fix only with the user's approval.
- **`add`** — ingests a skill that didn't come through skills.sh (received from a friend, downloaded, or a bare prompt), runs a safety check, shows a diff against any existing version, stamps provenance + content hash, places the canonical copy in the store, links it into the chosen agent roots, and commits + pushes to the private remote. (Installing skills.sh-sourced skills is skills.sh's job — `npx skills add`.)
- **`ingest`** *(v1.1)* — the bulk pipeline for messy source directories (ADR-0009): point it at a directory of skills in any packaging (folders, `.zip`/`.skill`/`.skill.zip` archives, bare `SKILL.md` files) plus raw prompt documents; it classifies every item, clusters variants, and reports a proposed resolution — winners with reasons, discarded variants, junk, safety findings, unresolved conflicts. `--apply` stores the approved winners with provenance in one commit: read-only on the source, links nothing. Prompt documents are deterministically wrapped into skills (ADR-0010).
- **`diff`** — shows what changed in a skill since the stored version ("a friend sent v2 — what's new?").

**Personal** skills live in a **local canonical store** — a git repo with an optional **private remote** for versioning (`add` commits and pushes). **External** skills are owned by skills.sh (its `skills-lock.json`); Skill Ninja audits them but does not manage them. A static HTML status page is deferred to v1.1.

## User Stories

### Init / analyze
1. As a user, I want to run an init command so Skill Ninja discovers which coding agents are installed on my machine.
2. As a user, I want Skill Ninja to discover all agent roots (e.g. `~/.claude/skills`, `~/.agents/skills`) and the skills within them.
3. As a user, I want Skill Ninja to scan my Obsidian vault(s) so vault-stored skills are included.
4. As a user, I want Skill Ninja to detect project-scoped skills in my project working directories.
5. As a user, I want to configure which roots and vaults are scanned, so I can include or exclude locations.
6. As a user, I want the analysis to be cached so subsequent commands are fast.
7. As a non-technical user, I want to be guided through first-run setup in plain language.

### Status
8. As a user, I want to see all my skills across all agents and vaults in one view.
9. As a user, I want to see where each skill physically lives (which root / vault / project).
10. As a user, I want duplicates — the same skill in multiple places — flagged.
11. As a user, I want broken symlinks flagged so I know what isn't actually working.
12. As a user, I want to see the version of each skill, where known.
13. As a user, I want to see each skill's provenance (authored / received / external, source, when imported).
14. As a user, I want to filter the status view (e.g. only broken, only duplicates, only personal).
15. As a non-technical user, I want to understand the status view without technical knowledge.

### Doctor
16. As a user, I want a doctor command that detects problems in my skill landscape.
17. As a user, I want the doctor to offer to repair broken symlinks.
18. As a user, I want the doctor to offer to deduplicate (consolidate the same skill to one place + link).
19. As a user, I want the doctor to detect orphaned or stale skills.
20. As a user, I want to approve each repair before it is applied — no silent changes.
21. As a user, I want a summary of what the doctor changed.

### Add skill
22. As a user, I want to add a skill I received from a friend (a folder or file).
23. As a user, I want to add a skill from a single prompt (bare `SKILL.md` content).
24. As a user, I want to add a skill from a git repo or URL.
25. As a user, I want Skill Ninja to run a safety check on an incoming skill (risky content such as unbounded shell, network calls, hidden commands).
26. As a user, I want safety findings shown in plain language before installing.
27. As a user, I want to diff an incoming skill against any existing version I have, so I see what is new.
28. As a user, I want to choose where the skill is installed (canonical store, and which agent roots/vaults receive the link or copy).
29. As a user, I want provenance recorded automatically (source, from, imported date).
30. As a user, I want the skill versioned and stamped.
31. As a user, I want the addition committed to my Git remote (if configured) so it is backed up.

### Diff
32. As a user, I want to see what changed in a skill since I last stored it.
33. As a user, I want to diff a skill against an upstream/external version to see whether an update is available.
34. As a user, I want the diff shown in a readable form.

### Cross-cutting / install / storage
35. As a user, I want to install Skill Ninja with one command (`npx skills add MarcoHerten/skill-ninja`).
36. As a user, I want Skill Ninja to work across multiple agents (Claude Code, Codex, …) without separate setup.
37. As a user, I want to keep my skills in a private, versioned store (optional Git remote).
38. As a user, I want context hygiene — a coding project not flooded with irrelevant (e.g. content/SEO) skills.
39. As a user, I want to operate entirely via the coding agent (slash commands), not a separate terminal app.
40. As a non-technical teammate, I want to manage skills without touching the filesystem by hand.
41. As a user, I want a status page (v1.1) to view my skill landscape in a browser as a static HTML page.
42. As a user, I want Skill Ninja to avoid the anti-patterns of earlier attempts — no manual catalog, no multi-target deploy scripts, no sync-as-transport.

### Bulk ingest (v1.1)
43. As a user with a messy export directory (skills as folders, zips, `.skill` archives, bare files, and plain prompts), I want to point `/ninja ingest` at it and get an analysis report — with nothing changed yet.
44. As a user, I want the report to group the mess into clusters and propose one winner per cluster, each with a plain-language reason.
45. As a user, I want non-skill junk (PDFs, dashboards, export metadata, backups) listed as skipped — never ingested, never deleted.
46. As a user, I want divergent duplicates the rules can't resolve flagged as needs-decision, with the agent proposing a batch resolution I approve once per cluster group.
47. As a user, I want prompt documents wrapped into skills (name derived, description marked needs-review) so a prompt library becomes one manageable unit type.
48. As a user, I want ingest to store winners only in my canonical store — one commit (+ push) for the whole batch, nothing linked into my agents.
49. As a user, I want the source directory left completely untouched.
50. As a user, I want re-ingesting the same directory to be a no-op for unchanged skills and a diff-based decision for changed ones.

## Implementation Decisions

- **Form factor — hybrid.** Skill Ninja ships as a skill (`SKILL.md`, the orchestration/interface layer the agent drives via slash commands) bundled with a **Node.js engine** that performs the deterministic work (inventory, hash, diff, doctor). The skill is the interface; the engine is the muscle.
- **Standalone, but delegates installation.** Self-contained for its own concerns (audit, health, provenance), but it does **not** reimplement the installer — installation, agent targeting, and security scanning belong to **skills.sh** (`npx skills`), which also installs Skill Ninja itself (ADR-0007). It coexists with skills.sh rather than wrapping its CLI: each owns its own skill population. Earlier personal tools (`skill-intake`, `skill-inventory.py`) are design references Skill Ninja generalizes and replaces.
- **Distribution.** Published as a GitHub repo in the standard `skills/ninja/SKILL.md` layout, installable via `npx skills add MarcoHerten/skill-ninja`. Multi-agent targeting, global vs project scope, and hash-based updates are provided by skills.sh for free. A managed Claude Code plugin channel may follow later (dual-channel model).
- **Relationship to skills.sh (ADR-0007).** Three layers: skills.sh installs (and installs Skill Ninja too); Skill Ninja audits, heals, and stamps provenance; a private GitHub repo versions Personal skills. `add` is the non-skills.sh path (received/downloaded/prompt); Skill Ninja links the Personal skills it owns, skills.sh links the External skills it owns.
- **`init` bootstraps configuration (ADR-0008).** On a fresh machine `init` needs no pre-existing config — it discovers the landscape (agent roots by existence-probe, Obsidian vaults from `obsidian.json`, project dirs), seeds `~/.skill-ninja/config.json`, creates the store + `git init`, then scans. Re-running re-discovers and re-seeds (how config is edited — no `config set` DSL).
- **Runtime — Node.js.** The engine scripts are Node, because the `npx` install guarantees Node is present; no Python (or other runtime) dependency is imposed on public users.
- **Storage model.** A local **canonical store** (default `~/.skill-ninja/store`) holds **Personal** skills; it is a git repo with an optional **private remote**, and `add` commits and pushes. Personal skills are linked into the relevant agent roots by Skill Ninja. **External skills** are owned by skills.sh (recorded in its `skills-lock.json`) — Skill Ninja audits them but does not manage or re-link them. Two linking systems coexist, separated by tier.
- **Skill identity & versioning.** Each managed skill carries frontmatter stamps — `version`, `updated`, `provenance { source, from, imported, derived_from, relation }` — plus a **content hash**. Stamps add to the skill's own frontmatter without dropping it (the `description` is preserved); `relation` records the relationship to a comparable skill (ported from `skill-intake`). Before ingest, `add` surfaces **comparable skills** in the store — same name stems, overlapping descriptions, or identical content — and the skill layer walks a comparison report (trigger collisions, dangling references, variant integrity → replace / parallel / merge / reject). (Generalizes a proven personal convention.)
- **Bulk ingest — a sixth command (v1.1, ADR-0009/0010).** `ingest <dir>` is its own pipeline, not a bulk mode of `add`: two-phase like `doctor` (analyze + report dry run, then `--apply`), read-only on the source, store-only (no linking — context hygiene). Every item classifies as skill package (any packaging, `SKILL.md` at any nesting level or under non-standard names, archives sniffed by magic bytes), prompt document (deterministically wrapped into a skill: name from the normalized stem, original text and frontmatter preserved, description empty + needs-review, curated later in batches), or junk (skipped + reported; assets inside a package always travel). Cluster identity is the normalized `name` (fallback: the stem); winner priority: folder > archive, version signal > mtime, byte-identical members collapse. Losers are reported, not stored (lineage on the winner's `derived_from`). Divergent duplicates become needs-decision items the agent layer resolves in user-approved batches. Re-ingest is idempotent by name + content hash.
- **Tool asymmetry.** Skill Ninja abstracts over agent roots: it knows each agent's root and places/links a skill into all relevant ones so one logical skill is available everywhere, without the user thinking about it.
- **Commands.** `init`, `status`, `doctor`, `add`, `diff` (v1.0) and `ingest` (v1.1) — invoked by the agent through the skill's slash commands, which call the Node engine.
- **Safety check.** Lightweight static analysis of skill content (over `SKILL.md` and any bundled scripts) flagging risky patterns, combined with provenance/source trust. Not a sandbox.
- **No anti-patterns.** Status is computed on demand — there is no manually-maintained catalog/index to keep in sync. No multi-target deploy scripts. No sync-as-transport.

## Testing Decisions

- **One automated seam — the Node CLI engine against fixture filesystems.** Each command (`init | status | doctor | add | diff`) is invoked inside a sandboxed fake `$HOME` containing configured agent roots, a fake Obsidian vault, and sample skills — including deliberately planted duplicates, broken symlinks, and skills with and without provenance/version stamps.
- **What tests assert on:** the CLI's output (report/status) **and** the resulting filesystem state (files placed/removed, symlinks created/repaired, store/manifest entries, provenance and version stamps written).
- **Black-box by design:** CLI in, filesystem + stdout out. Internal refactors do not break tests. This is the highest, most stable seam.
- **Greenfield:** there are no existing seams or in-repo prior art to reuse. A Node test runner (e.g. the built-in `node:test`) against fixture directories is the intended mechanism; the exact runner is a build-time choice.
- **Good-test principle:** test external behavior — what a command does to the filesystem and what it reports — never internal module structure.
- **Skill layer (manual):** the `SKILL.md` orchestration that guides the agent through `add`/intake is walked manually; it is not deterministically unit-testable.
- **`ingest` fixtures reproduce the audited pathologies (v1.1).** Classification, name normalization (NFC, slug, suffix stripping), archive sniffing, and cluster resolution are tested against fixture directories mirroring the two real-world samples the design was decided against: one skill in four packagings, version clusters (v-suffix, semver, date codes), folder name ≠ frontmatter `name`, broken frontmatter, `__MACOSX` entries, NFD filenames, divergent same-name duplicates, prompt documents, and junk. Tests assert the dry run mutates nothing, and check the post-`--apply` filesystem, store stamps, and single-commit git state.

## Out of Scope

- **Status page / HTML dashboard** — deferred to v1.1.
- **Source-directory cleanup** — `ingest` never mutates the directory it analyzes; tidying the source is a separate activity, if ever.
- **Bulk linking** — `ingest` stores without linking; a command to link stored skills into agent roots in bulk may follow later.
- **Bulk git/URL sources** — `ingest` takes local directories; repo/URL sources remain `add`'s job.
- **Description curation for wrapped prompts** — a follow-up activity with its own flow (ADR-0010), not part of `ingest`.
- **Managed Claude Code plugin channel** — future; the skills.sh channel is the v1.0 distribution path.
- **Sandboxed execution / deep security analysis** — only a lightweight static safety check in v1.0.
- **Auto-updating external skills** — delegated to `npx skills update`; Skill Ninja reports available updates but does not replace skills.sh.
- **Cloud hosting / a hosted service** — Skill Ninja is local-first; the only network is the optional Git remote and the skills.sh install.
- **GUI application** — agent slash-commands + CLI only.
- **Multi-user / shared team stores** — single-user per installation.

## Further Notes

- **Load-bearing decisions:** public product; standalone system that delegates installation to skills.sh (ADR-0007); local canonical store + optional private Git remote; Node engine + skill interface; `init` bootstraps configuration (ADR-0008); the five v1.0 commands, plus v1.1 bulk `ingest` as a read-only, two-phase, store-only pipeline (ADR-0009) that wraps prompt documents into skills (ADR-0010); status page deferred to v1.1.
- **Design references:** a prior personal skill store (tier model, frontmatter/provenance convention, dual-linking) and `mattpocock/skills` (distribution + dual-channel model). **Anti-pattern reference:** an earlier overloaded attempt — avoid its manual catalog, multi-target deploy script, and sync-as-transport.
- **Build sequencing:** although the spec covers all of v1.0, the build can still sequence features — `init` + `status` first (the "see your chaos" core), then `add` + `diff`, then `doctor`. For v1.1, `ingest` slices naturally bottom-up: classification + normalization first (directly testable against the audited sample directories), then cluster resolution + report, then `--apply` (store, stamp, one commit). Slicing is decided at `/to-tickets`.
