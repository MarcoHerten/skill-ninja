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
Skill Ninja's local source-of-truth directory for Personal skills — the copy every agent-root link points to. A git repo with a private remote; `add` commits and pushes.
_Avoid_: the library (that's Skill-Library), the repo.

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
