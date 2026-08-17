# Skill Ninja

> A skill health & provenance layer for AI coding agents — see where every skill lives, keep the landscape clean, and safely ingest the skills that don't come through [skills.sh](https://skills.sh).

## The problem

AI coding agents (Claude Code, Codex, Cursor, …) consume **skills** — instruction files that tell them how to do things. As you collect skills, they turn into chaos: scattered across agents and Obsidian vaults, sometimes global, sometimes per-project, often symlinked or buried where agents can't reach them. You can't see what's where, spot duplicates or broken links, track versions, or tell what changed when someone sends you an updated skill.

Existing options are either ad-hoc (a folder of symlinks) or overloaded multi-tool setups. Non-experts are left to manage it all by hand.

## What Skill Ninja does

Skill Ninja runs **inside your coding agent**, on top of the skills [skills.sh](https://skills.sh) (or you) placed there. **skills.sh installs skills; Skill Ninja looks after them** — one clear picture of the landscape, plus the tools to keep it healthy:

- **`/ninja init`** — analyzes your machine: which agents are installed, where every skill lives across roots and vaults (no config needed on first run — it's created for you).
- **`/ninja status`** — one inventory view: per-agent reachability, copy-vs-symlink, global-vs-project, duplicates, broken symlinks, versions, and provenance.
- **`/ninja doctor`** — detects and repairs problems (broken links, duplicates, orphans), with your approval for each fix.
- **`/ninja add`** — ingests a skill that didn't come through skills.sh (a friend, a download, a bare prompt): safety check, diff, provenance + content-hash stamp, and install. Versioned in your private GitHub repo.
- **`/ninja ingest`** *(dry run live, v1.1)* — point it at a messy directory (a skills export, a prompt library): it classifies everything, clusters the variants, and reports what it would keep — one winner per cluster, losers with hashes and reasons, junk, safety findings, and side-by-sides for the divergent duplicates no rule can resolve. On `--apply` it stores the winners, versioned in one commit — the source is never touched, nothing is auto-linked.
- **`/ninja diff`** — shows what changed in a skill since you stored it ("my friend sent v2 — what's new?"), or against the upstream skills.sh source.

Your **personal** skills live in a **local canonical store** — a git repo with an optional **private remote** for versioning. Skills you installed via skills.sh stay owned by skills.sh; Skill Ninja watches over everything.

## Quick start

The whole product runs inside your coding agent as slash commands. This is the intended workflow — from install to a clean, versioned skill landscape in a few minutes.

### 1. Install (once)

```bash
npx skills add MarcoHerten/skill-ninja
```

This installs Skill Ninja as a skill into your agent(s) — the same distribution channel it later watches over.

### 2. Take stock: `init`, then `status`

```
/ninja init
/ninja status
```

`init` needs no preparation: it discovers which coding agents are on your machine, finds every skill across agent roots, Obsidian vaults, and project directories, and bootstraps the config (`~/.skill-ninja/config.json`) plus your **canonical store** (`~/.skill-ninja/store`, git-initialized). `status` then gives you the one inventory view — duplicates, broken symlinks, versions, provenance. Re-run either whenever the landscape changes; filters like `/ninja status --duplicates` narrow the view.

### 3. Clean up: `doctor`

```
/ninja doctor
```

Detects broken links, duplicate spreads, and orphaned copies — and proposes a repair for each. Nothing is touched until you approve: re-run with `--apply` to execute the fixes you agreed to.

### 4. Turn on versioning (recommended, once)

Every skill Skill Ninja stores is committed to the store's git repo. For off-machine backup and browsable history, create a **private** GitHub repo and wire it up:

```bash
git -C ~/.skill-ninja/store remote add origin git@github.com:<you>/skill-store.git
```

Keep that repo private — personal skills often carry company context. No remote? Skill Ninja still commits locally and skips pushing silently.

### 5. Day to day: one skill arrives → `add`

```
/ninja add <folder|file|zip|repo>
```

The curated path for a single skill that didn't come through skills.sh: safety check, diff against any stored version, provenance + content-hash stamp, linking into your agent roots, commit + push. Bare prompt text works too (`--prompt`), and `--from` records who sent it.

### 6. A whole messy directory → `ingest`

```
/ninja ingest ~/Downloads/skills-export
```

The bulk path: the export with the same skill as folder, `.zip`, `.skill`, *and* `.skill.zip`; the prompt library that was never skills at all. The dry run classifies every item, clusters the variants, and reports the proposed resolution — winner per cluster with its reason, losers with content hashes, junk, a safety column, and `needs-decision` side-by-sides for divergent duplicates. Walk the report, decide the conflicts, then `--apply` (shipping with v1.1) stores the winners in one commit. The source directory is never modified; nothing is auto-linked into your agents — keep your context lean and link deliberately via `add`.

### 7. Something changed → `diff`

```
/ninja diff <name> <candidate>
```

"A friend sent v2 — what's new?" The comparison runs over the skill body, so stamping churn never shows up as a change.

### Rule of thumb

| Situation | Command |
| --- | --- |
| Skill came through skills.sh | manage with `npx skills` — Skill Ninja audits it, but doesn't re-link it |
| One new skill from a friend, download, or prompt | `/ninja add` |
| A whole export / prompt library | `/ninja ingest` |
| Landscape feels off | `/ninja status`, then `/ninja doctor` |
| An updated copy of a stored skill shows up | `/ninja diff`, then `/ninja add` |

## Status

🚧 **Early — v1.0 command surface implemented; v1.1 bulk ingest under construction.** v1.0 is live: `init` (bootstrap + scan), `status`, `doctor`, `add` (safety check, stamping, commit + push), `diff`. The v1.1 `ingest` dry run is live end to end — classification, deterministic cluster resolution (winners / losers / needs-decision with side-by-sides), prompt wrapping, and the safety column ([ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)); `--apply` (store the winners, one commit) follows. The skill is invoked as `/ninja` (e.g. `/ninja init`). See [`SPEC.md`](./SPEC.md), [`CONTEXT.md`](./CONTEXT.md), and [`docs/adr/`](./docs/adr).

## Install

```bash
npx skills add MarcoHerten/skill-ninja
```

Distribution via [skills.sh](https://skills.sh) (`npx skills`) — multi-agent targeting, global vs project scope, and hash-based updates come for free. The same routine installs the skills Skill Ninja then watches over.

## Roadmap

- **v1.0** ✅ — `init`, `status`, `doctor`, `add` (+ safety check), `diff`
- **v1.1** — `ingest` (bulk pipeline for messy skill/prompt directories — [ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)): dry run ✅, `--apply` next; static HTML status page

## Design principles

- **Local-first** — your skills stay on your machine; the only network is the optional Git remote.
- **One source of truth per tier** — a canonical store for personal skills (linked into each agent's root), and skills.sh's lockfile for the skills it installed. Skill Ninja audits across both.
- **Agent-native** — operated via slash commands in your coding agent, not a separate app.
- **Safe by default** — a lightweight safety check on every incoming skill.

## License

TBD.
