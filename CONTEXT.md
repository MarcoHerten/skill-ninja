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

### The product

**Skill Ninja**:
The standalone skill-management product this effort builds. Installed as a skill, it analyzes, inventories, repairs, and ingests skills across a user's agents and vaults.
_Avoid_: the manager, the framework, the tool (say Skill Ninja).

**Skill-Library**:
Marco's pre-existing personal skill store (a private git repo). It is the design reference Skill Ninja generalizes, and is replaced by Skill Ninja in his own workflow — not a runtime dependency.
_Avoid_: the library, the repo (ambiguous — say Skill-Library, or the user's store).

### Where skills live — the tiers

**Personal skill**:
A skill the user authored or received and owns; lives in the user's canonical store, versioned under their control.
_Avoid_: own skill, custom skill.

**External skill**:
A skill sourced from a third-party collection (e.g. skills.sh, a public repo), installed and tracked by an external installer and its own lockfile — not owned by the user.
_Avoid_: third-party skill, npx skill (name the tier, not the mechanism).

**Project skill**:
A skill scoped to a single project's working directory rather than installed globally.
_Avoid_: local skill.

**Plugin**:
A managed, read-only skill bundle distributed through an agent's own marketplace (e.g. a Claude Code plugin), updated by the agent rather than the user.
_Avoid_: extension, add-on.

### The environment

**Agent root**:
The directory a given coding agent reads skills from (e.g. `~/.claude/skills`, `~/.agents/skills`). Different agents read different roots.
_Avoid_: skills folder, skill dir.

**Tool asymmetry**:
The fact that different agents read different agent roots, so one logical skill must be placed in several roots to be available everywhere — the core problem Skill Ninja abstracts over.
_Avoid_: multi-tool problem (say tool asymmetry).
