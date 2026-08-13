# Skill Ninja

> A standalone skill manager for AI coding agents — see, clean up, and safely add the skills your agents consume.

## The problem

AI coding agents (Claude Code, Codex, Cursor, …) consume **skills** — instruction files that tell them how to do things. As you collect skills, they turn into chaos: scattered across agents and Obsidian vaults, sometimes global, sometimes per-project, often symlinked or buried where agents can't reach them. You can't see what's where, spot duplicates or broken links, track versions, or tell what changed when someone sends you an updated skill.

Existing options are either ad-hoc (a folder of symlinks) or overloaded multi-tool setups. Non-experts are left to manage it all by hand.

## What Skill Ninja does

Skill Ninja runs **inside your coding agent** and gives you one clear picture of your skill landscape, plus the tools to keep it healthy:

- **`/init`** — analyzes your machine: which agents are installed, where every skill lives across roots and vaults.
- **`status`** — one inventory view: locations, duplicates, broken symlinks, versions, and provenance.
- **`doctor`** — detects and repairs problems (broken links, duplicates, orphans), with your approval for each fix.
- **`add`** — ingests a skill from anywhere (a friend, a prompt, a repo), runs a safety check, shows a diff, and installs it where you choose.
- **`diff`** — shows what changed in a skill since you stored it ("my friend sent v2 — what's new?").

Your skills live in a **local canonical store** with an **optional private Git remote** for versioning and sync — one source of truth, private, versioned.

## Status

🚧 **Early — specification stage.** The design is being sharpened; there is no usable build yet. See [`SPEC.md`](./SPEC.md) for the v1.0 specification and [`CONTEXT.md`](./CONTEXT.md) for the vocabulary.

## Install (planned)

```bash
npx skills add MarcoHerten/skill-ninja
```

Distribution via [skills.sh](https://skills.sh) (`npx skills`) — multi-agent targeting, global vs project scope, and hash-based updates come for free.

## Roadmap

- **v1.0** — `init`, `status`, `doctor`, `add` (+ safety check), `diff`
- **v1.1** — static HTML status page

## Design principles

- **Local-first** — your skills stay on your machine; the only network is the optional Git remote.
- **One source of truth** — a canonical store, with links into each agent's root (resolving the fact that different agents read different directories).
- **Agent-native** — operated via slash commands in your coding agent, not a separate app.
- **Safe by default** — a lightweight safety check on every incoming skill.

## License

TBD.
