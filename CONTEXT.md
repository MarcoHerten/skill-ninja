# Skill Ninja

A standalone, public product for managing the **skills** that AI coding agents consume — analyzing a user's machine, surfacing where every skill lives, cleaning up the mess, and ingesting new ones safely. This glossary fixes the vocabulary the spec and code speak in.

## Language

### The managed unit

**Skill**:
A self-contained instruction package an AI coding agent loads and follows — a `SKILL.md` plus any bundled assets, placed in an agent root.
_Avoid_: prompt, command, agent skill, rule.

**Provenance**:
The recorded origin and lineage of a skill — where it came from (authored, received, external), from whom, when imported, and what it was renamed from. The trail that lets Skill Ninja answer "what changed?" and "do I trust this?".
_Avoid_: source (overloaded), metadata, history.

**Duplicate**:
The signal that a skill is present more than once. Identity is by **name** (the key `add` / `diff` / skills.sh use); the **content hash** is the secondary signal that catches the same skill living under a different name. Surfaced in `status` and `doctor`.
_Avoid_: conflict, clash.

**Candidate**:
Every filesystem item `ingest` classifies during analysis — a skill package in any packaging form (folder, `.zip`/`.skill`/`.skill.zip` archive, bare `SKILL.md`), a prompt document, or a non-ingestable artifact. Candidates group into clusters; only cluster winners become skills.
_Avoid_: item, entry, find.

**Cluster**:
The set of candidates `ingest` believes are the same logical skill — same normalized identity across packagings, copies, and versions. One winner per cluster is stored; the report shows every member and why the winner won.
_Avoid_: duplicate group (a Duplicate is the `status` symptom; a cluster is the ingest-time grouping), version family.

**Wrap**:
The deterministic conversion of a prompt document into a skill package — `name` derived from the normalized filename, the prompt text preserved as the body, `description` initially empty. Ingest's answer to libraries that were never skills.
_Avoid_: import (too generic), conversion.

### The product

**Skill Ninja**:
The standalone skill-management product this effort builds. Installed as a skill, it analyzes, inventories, repairs, and ingests skills across a user's agents and vaults.
_Avoid_: the manager, the framework, the tool (say Skill Ninja).

**Skill-Library**:
Marco's pre-existing personal skill store (a private git repo). It is the design reference Skill Ninja generalizes, and is replaced by Skill Ninja in his own workflow — not a runtime dependency.
_Avoid_: the library, the repo (ambiguous — say Skill-Library, or the user's store).

**skills.sh**:
The external skill installer (`npx skills`, Vercel Labs) Skill Ninja delegates installation to — 76 agents, symlink or copy, security scan, project lockfile. Also the channel Skill Ninja itself is installed through.
_Avoid_: the CLI, npx skills (say skills.sh).

**Ingest**:
The bulk pipeline (`/ninja ingest`): analyze a directory of candidates, cluster them, and report the proposed resolution; on explicit approval (`--apply`) store the winners with provenance. Read-only on the source directory and links nothing — storing, not installing. `add` remains the curated single-skill path.
_Avoid_: bulk add, import (say ingest).

### Where skills live — the tiers

**Personal skill**:
A skill the user authored or received and Skill Ninja owns — stamped with `version` / `hash` / `provenance`, canonically stored, and versioned in the user's private GitHub remote. Skill Ninja (not skills.sh) installs and links these.
_Avoid_: own skill, custom skill.

**External skill**:
A skill installed and tracked by **skills.sh** (the installer), recorded in its project lockfile `skills-lock.json` (`source`, `computedHash`). Owned by skills.sh, not the user — Skill Ninja audits it but does not manage or re-link it.
_Avoid_: third-party skill, npx skill (name the tier, not the mechanism).

**Project skill**:
A skill scoped to a single project's working directory rather than installed globally.
_Avoid_: local skill.

**Plugin**:
A managed, read-only skill bundle distributed through an agent's own marketplace (e.g. a Claude Code plugin), updated by the agent rather than the user.
_Avoid_: extension, add-on.

**Canonical store**:
Skill Ninja's local source-of-truth directory for Personal skills — the copy every agent-root link points to. A **visible** git repository in the user's home directory, `~/skill-ninja-store` by default; the name (or full path) is chosen via `init --store`. Pushed to a private remote; every stored-skill change (`add`, `ingest --apply`, `cat assign`, availability switches) lands as a commit, so the repo's history is the per-skill change log (ADR-0016).
_Avoid_: the library (that's Skill-Library), the repo.

### Availability — the lever on the context window

**Availability**:
Whether — and how — an agent may load a skill: **Active** (loaded, auto-triggered), **Manual** (listed and invocable by name, never auto-triggered), or **Off** (loaded nowhere). Skill Ninja's lever on the context window; switched with `on` / `manual` / `off`.
_Avoid_: activation mode, enablement, visibility.

**Activation Text**:
A skill's `description` in its role as the text an agent matches on to trigger it. While a skill is Manual, it is preserved under the `activation_text` stamp; switching back to Active restores it to `description`.
_Avoid_: trigger text, backup description.

**Profile**:
A named, reusable set of skills that `profile apply` pulls into a project's working directory via project-local links — additive on the global Availability baseline, so one repo can carry its content skills and another its code skills.
_Avoid_: setup, bundle, preset, workspace config.

**Collection**:
A named, personal filter over the inventory — a list of exact skill names or `prefix*` patterns living in the user's local config, resolved live by the views (`cat @<name>`, `find @<name>`, the page filter) and the availability selectors. The owner's view, not data about the skill.
_Avoid_: tag, label, category (that is content taxonomy on the skill, ADR-0013), group.

### The environment

**Agent root**:
The directory a given coding agent reads skills from (e.g. `~/.claude/skills`, `~/.agents/skills`). Different agents read different roots.
_Avoid_: skills folder, skill dir.

**Tool asymmetry**:
The fact that different agents read different agent roots, so one logical skill must be placed in several roots to be available everywhere — the core problem Skill Ninja abstracts over.
_Avoid_: multi-tool problem (say tool asymmetry).

**Scan root**:
One of the locations `init` walks for skills — an agent root, an Obsidian vault, or a configured project directory. `status` reports per scan root. (In an earlier draft this was named `scope` in the code and inventory schema; the rename is complete — see ADR-0003.)
_Avoid_: scope (reserved for the global-vs-project tier sense — see Project skill).
