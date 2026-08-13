# Skill Ninja — v1.0 Specification

> Vocabulary: see [`CONTEXT.md`](./CONTEXT.md) (Skill, Skill Ninja, Provenance, the tiers, Agent root, Tool asymmetry).
> Status: specification stage — no usable build yet.

## Problem Statement

Skills — the instruction files AI coding agents (Claude Code, Codex, Cursor, …) consume — are chaos, especially for non-expert users. They end up scattered across multiple agents' skill directories and Obsidian vaults: sometimes global, sometimes per-project, sometimes symlinked, often buried where agents can't reach them. Users cannot see what is where, spot duplicates or broken symlinks, track versions, or tell what changed when a collaborator sends an updated skill weeks later.

Existing approaches are either ad-hoc (a hand-managed folder of symlinks) or overloaded multi-tool orchestrations. There is no single, easy tool that gives a non-expert a clear picture of their skill landscape and lets them safely add, repair, and version skills across all of their agents.

## Solution

**Skill Ninja** — a standalone, public skill-management product, installed as a skill via `npx skills add MarcoHerten/skill-ninja`. It runs inside the coding agent and provides five capabilities:

- **`init`** — analyzes the machine: which coding agents are installed, and where every skill lives across agent roots and Obsidian vaults.
- **`status`** — one inventory view: each skill's location, duplicates, broken symlinks, versions, and provenance.
- **`doctor`** — detects and repairs problems (broken links, duplicates, orphans), applying each fix only with the user's approval.
- **`add`** — ingests a new skill from anywhere (a friend, a bare prompt, a repo/URL), runs a safety check, shows a diff against any existing version, installs it where the user chooses, and records provenance.
- **`diff`** — shows what changed in a skill since the stored version ("a friend sent v2 — what's new?").

Each user's skills live in a **local canonical store** with an **optional private Git remote** for versioning and sync. A static HTML status page is deferred to v1.1.

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

## Implementation Decisions

- **Form factor — hybrid.** Skill Ninja ships as a skill (`SKILL.md`, the orchestration/interface layer the agent drives via slash commands) bundled with a **Node.js engine** that performs the deterministic work (inventory, hash, diff, doctor). The skill is the interface; the engine is the muscle.
- **Standalone product.** Built as a self-contained system with its own scripts. It does **not** wrap any one user's existing tooling; earlier personal tools (a prior `skill-intake` skill, a `skill-inventory.py`) are design references that Skill Ninja generalizes and replaces.
- **Distribution.** Published as a GitHub repo in the standard `skills/skill-ninja/SKILL.md` layout, installable via `npx skills add MarcoHerten/skill-ninja`. Multi-agent targeting, global vs project scope, and hash-based updates are provided by skills.sh for free. A managed Claude Code plugin channel may follow later (dual-channel model).
- **Runtime — Node.js.** The engine scripts are Node, because the `npx` install guarantees Node is present; no Python (or other runtime) dependency is imposed on public users.
- **Storage model.** Each user has a local **canonical store** (configurable path); an **optional private Git remote** provides versioning and sync. Personal skills live canonically in this store and are linked into the relevant agent roots. **External skills** (from skills.sh etc.) remain owned by their own installers and lockfiles — Skill Ninja inventories them but does not manage them.
- **Skill identity & versioning.** Each managed skill carries frontmatter stamps — `version`, `updated`, `provenance { source, from, imported, derived_from }` — plus a **content hash**. (Generalizes a proven personal convention.)
- **Tool asymmetry.** Skill Ninja abstracts over agent roots: it knows each agent's root and places/links a skill into all relevant ones so one logical skill is available everywhere, without the user thinking about it.
- **Commands.** `init`, `status`, `doctor`, `add`, `diff` — invoked by the agent through the skill's slash commands, which call the Node engine.
- **Safety check.** Lightweight static analysis of skill content (over `SKILL.md` and any bundled scripts) flagging risky patterns, combined with provenance/source trust. Not a sandbox.
- **No anti-patterns.** Status is computed on demand — there is no manually-maintained catalog/index to keep in sync. No multi-target deploy scripts. No sync-as-transport.

## Testing Decisions

- **One automated seam — the Node CLI engine against fixture filesystems.** Each command (`init | status | doctor | add | diff`) is invoked inside a sandboxed fake `$HOME` containing configured agent roots, a fake Obsidian vault, and sample skills — including deliberately planted duplicates, broken symlinks, and skills with and without provenance/version stamps.
- **What tests assert on:** the CLI's output (report/status) **and** the resulting filesystem state (files placed/removed, symlinks created/repaired, store/manifest entries, provenance and version stamps written).
- **Black-box by design:** CLI in, filesystem + stdout out. Internal refactors do not break tests. This is the highest, most stable seam.
- **Greenfield:** there are no existing seams or in-repo prior art to reuse. A Node test runner (e.g. the built-in `node:test`) against fixture directories is the intended mechanism; the exact runner is a build-time choice.
- **Good-test principle:** test external behavior — what a command does to the filesystem and what it reports — never internal module structure.
- **Skill layer (manual):** the `SKILL.md` orchestration that guides the agent through `add`/intake is walked manually; it is not deterministically unit-testable.

## Out of Scope

- **Status page / HTML dashboard** — deferred to v1.1.
- **Managed Claude Code plugin channel** — future; the skills.sh channel is the v1.0 distribution path.
- **Sandboxed execution / deep security analysis** — only a lightweight static safety check in v1.0.
- **Auto-updating external skills** — delegated to `npx skills update`; Skill Ninja reports available updates but does not replace skills.sh.
- **Cloud hosting / a hosted service** — Skill Ninja is local-first; the only network is the optional Git remote and the skills.sh install.
- **GUI application** — agent slash-commands + CLI only.
- **Multi-user / shared team stores** — single-user per installation.

## Further Notes

- **Load-bearing decisions:** public product (Q2); standalone system, not a wrapper (Q4/Q5); local canonical store + optional private Git remote (Q6); Node engine + skill interface (Q7); all five commands in the v1.0 spec (Q8), with the status page deferred to v1.1.
- **Design references:** a prior personal skill store (tier model, frontmatter/provenance convention, dual-linking) and `mattpocock/skills` (distribution + dual-channel model). **Anti-pattern reference:** an earlier overloaded attempt — avoid its manual catalog, multi-target deploy script, and sync-as-transport.
- **Build sequencing:** although the spec covers all of v1.0, the build can still sequence features — `init` + `status` first (the "see your chaos" core), then `add` + `diff`, then `doctor`. Slicing is decided at `/to-tickets`.
