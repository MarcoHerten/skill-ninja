# Skill Ninja

> A skill health & provenance layer for AI coding agents — see where every skill lives, keep the landscape clean, and safely ingest the skills that don't come through [skills.sh](https://skills.sh).

## The problem

AI coding agents (Claude Code, Codex, Cursor, …) consume **skills** — instruction files that tell them how to do things. As you collect skills, they turn into chaos: scattered across agents and Obsidian vaults, sometimes global, sometimes per-project, often symlinked or buried where agents can't reach them. You can't see what's where, spot duplicates or broken links, track versions, or tell what changed when someone sends you an updated skill.

Existing options are either ad-hoc (a folder of symlinks) or overloaded multi-tool setups. Non-experts are left to manage it all by hand.

## What Skill Ninja does

Skill Ninja runs **inside your coding agent**, on top of the skills [skills.sh](https://skills.sh) (or you) placed there. **skills.sh installs skills; Skill Ninja looks after them** — one clear picture of the landscape, plus the tools to keep it healthy:

- **`/init`** — analyzes your machine: which agents are installed, where every skill lives across roots and vaults (no config needed on first run — it's created for you).
- **`status`** — one inventory view: per-agent reachability, copy-vs-symlink, global-vs-project, duplicates, broken symlinks, versions, and provenance.
- **`doctor`** — detects and repairs problems (broken links, duplicates, orphans), with your approval for each fix.
- **`add`** — ingests a skill that didn't come through skills.sh (a friend, a download, a bare prompt): safety check, diff, provenance + content-hash stamp, and install. Versioned in your private GitHub repo.
- **`diff`** — shows what changed in a skill since you stored it ("my friend sent v2 — what's new?"), or against the upstream skills.sh source.

Your **personal** skills live in a **local canonical store** — a git repo with an optional **private remote** for versioning. Skills you installed via skills.sh stay owned by skills.sh; Skill Ninja watches over everything.

## Status

🚧 **Early — v1.0 command surface implemented; architecture sharpened.** Installation is delegated to skills.sh ([ADR-0007](./docs/adr/0007-skills-sh-installs-skill-ninja-audits.md)); `init` bootstraps configuration ([ADR-0008](./docs/adr/0008-init-bootstraps-config-and-discovers.md)). The engine is being realigned to these decisions. See [`SPEC.md`](./SPEC.md), [`CONTEXT.md`](./CONTEXT.md), and [`docs/adr/`](./docs/adr).

## Install

```bash
npx skills add MarcoHerten/skill-ninja
```

Distribution via [skills.sh](https://skills.sh) (`npx skills`) — multi-agent targeting, global vs project scope, and hash-based updates come for free. The same routine installs the skills Skill Ninja then watches over.

## Roadmap

- **v1.0** — `init`, `status`, `doctor`, `add` (+ safety check), `diff`
- **v1.1** — static HTML status page

## Design principles

- **Local-first** — your skills stay on your machine; the only network is the optional Git remote.
- **One source of truth per tier** — a canonical store for personal skills (linked into each agent's root), and skills.sh's lockfile for the skills it installed. Skill Ninja audits across both.
- **Agent-native** — operated via slash commands in your coding agent, not a separate app.
- **Safe by default** — a lightweight safety check on every incoming skill.

## License

TBD.
