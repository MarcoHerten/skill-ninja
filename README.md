# Skill Ninja

> A skill health & provenance layer for AI coding agents — see where every skill lives, keep the landscape clean, and safely ingest the skills that don't come through [skills.sh](https://skills.sh).

## The problem

AI coding agents (Claude Code, Codex, Cursor, …) consume **skills** — instruction files that tell them how to do things. As you collect skills, they turn into chaos: scattered across agents and Obsidian vaults, sometimes global, sometimes per-project, often symlinked or buried where agents can't reach them. You can't see what's where, spot duplicates or broken links, track versions, or tell what changed when someone sends you an updated skill.

Existing options are either ad-hoc (a folder of symlinks) or overloaded multi-tool setups. Non-experts are left to manage it all by hand.

## What Skill Ninja does

Skill Ninja runs **inside your coding agent**, on top of the skills [skills.sh](https://skills.sh) (or you) placed there. **skills.sh installs skills; Skill Ninja looks after them** — one clear picture of the landscape, plus the tools to keep it healthy:

- **`/ninja init`** — analyzes your machine: which agents are installed, where every skill lives across roots and vaults (no config needed on first run — it's created for you). Your **canonical store** lands as a visible git repo at `~/skill-ninja-store` by default — your own name or path via `init --store <name|path>`.
- **`/ninja status`** — one inventory view: per-agent reachability, copy-vs-symlink, global-vs-project, duplicates, broken symlinks, versions, and provenance.
- **`/ninja cat`** *(live, v1.2)* — the category catalog: browse your skills grouped by category (each with its one-line description), filter by a category term; `cat assign` stamps a category onto the stored copy. Categories live in the skill's frontmatter — never in a hand-maintained mapping ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md)) — and the status page groups by category too.
- **`/ninja page`** *(live, v1.1 — interactive cockpit since v1.3)* — renders the cached inventory as one self-contained static HTML page (`~/.skill-ninja/status.html`: inline styles + one inline script, no server, no external assets, no network) and prints the path. The browser counterpart of `/ninja status`, regenerated on every run — [ADR-0011](./docs/adr/0011-static-html-status-page.md). Since v1.3 it is the availability cockpit: search, availability/tier/category filters, checkbox bulk-selection generating a copyable `ninja … --apply` command — the page executes nothing, the engine stays behind `--apply`.
- **`/ninja doctor`** — detects and repairs problems (broken links, duplicates, orphans), with your approval for each fix.
- **`/ninja add`** — ingests a skill that didn't come through skills.sh (a friend, a download, a bare prompt): safety check, diff, provenance + content-hash stamp, a human-readable `CHANGELOG.md`, and install. Versioned in your private GitHub repo.
- **`/ninja ingest`** *(live, v1.1)* — point it at a messy directory (a skills export, a prompt library): it classifies everything, clusters the variants, and reports what it would keep — one winner per cluster, losers with hashes and reasons, junk, safety findings, and side-by-sides for the divergent duplicates no rule can resolve. On `--apply` it stores the winners (each with a `CHANGELOG.md` naming the batch and its superseded lineage), versioned in one commit — the source is never touched, nothing is auto-linked, and re-ingesting is a no-op for unchanged skills.
- **`/ninja on` / `/ninja off` / `/ninja manual`** *(live, v1.3)* — the **Availability** layer: your lever on the context window. `off` unloads a skill everywhere (Personal: unlink + `availability` stamp; External: a ZCode config disable tracked in a ledger), `manual` keeps it one slash away but never auto-triggered (the description is preserved as `activation_text` and restored on return), `on` re-activates — and doubles as install-on-demand for stored-but-unlinked skills. Uniform selectors (`--category`, `--tier personal`, `--except`), dry run by default, `--apply` executes — [ADR-0014](./docs/adr/0014-availability-layer.md).
- **`/ninja find`** *(live, v1.3)* — search the inventory by skill name, description, or category.
- **`/ninja profile`** *(live, v1.3)* — named skill sets per purpose ("the content setup", "the code setup"): `save` a member list, `apply` it in a repo (project-local symlinks, additive on the global baseline), `lift` it again.
- **`/ninja collection`** *(live, v1.3.1)* — named, personal filters over the inventory ("everything from Nils"): pattern lists in your local config, resolved live by `cat @<name>`, `find @<name>`, the page's dropdown, and `off/manual/on --collection`. Local-only by design — never on the skills, never in this repo ([ADR-0015](./docs/adr/0015-collections-are-config-side.md)).
- **`/ninja diff`** — shows what changed in a skill since you stored it ("my friend sent v2 — what's new?"), or against the upstream skills.sh source.

Your **personal** skills live in a **visible canonical store** — a named git repository in your home directory (`~/skill-ninja-store` by default; your own name or path via `init --store`), seeded with a README and an initial commit, pushed to an optional **private remote**. Its history is the per-skill change log: every stored-skill change (`add`, `ingest --apply`, `cat assign`, availability switches) lands as a commit. Skills you installed via skills.sh stay owned by skills.sh; Skill Ninja watches over everything.

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

`init` needs no preparation: it discovers which coding agents are on your machine, finds every skill across agent roots, Obsidian vaults, and project directories, and bootstraps the config (`~/.skill-ninja/config.json`) plus your **canonical store** — a visible, git-initialized repository at `~/skill-ninja-store`, seeded with a short README and an initial commit so it is presentable from the first push. On first run your agent proposes the default name and asks whether you'd like your own (a bare name like `my-skills` or a path like `~/code/skill-store`, passed as `init --store`); re-running `init` never renames or moves an existing store. `status` then gives you the one inventory view — duplicates, broken symlinks, versions, provenance. Re-run either whenever the landscape changes; filters like `/ninja status --duplicates` narrow the view. Prefer a browser? `/ninja page` writes the same view as a self-contained HTML file and tells you where.

### 3. Clean up: `doctor`

```
/ninja doctor
```

Detects broken links, duplicate spreads, and orphaned copies — and proposes a repair for each. Nothing is touched until you approve: re-run with `--apply` to execute the fixes you agreed to.

### 4. Turn on versioning (recommended, once)

Every skill Skill Ninja stores is committed to the store repo — the visible repository at `~/skill-ninja-store` (or the name/path you picked). For off-machine backup and browsable history, create a **private** GitHub repo and wire it up:

```bash
git -C ~/skill-ninja-store remote add origin git@github.com:<you>/skill-ninja-store.git
```

That is the intended setup: **one visible repo, pushed to a private remote, browsable per-skill history** — `add`, `ingest --apply`, `cat assign`, and availability switches all land as commits, so the log answers "what changed on this skill and when".

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

The bulk path: the export with the same skill as folder, `.zip`, `.skill`, *and* `.skill.zip`; the prompt library that was never skills at all. The dry run classifies every item, clusters the variants, and reports the proposed resolution — winner per cluster with its reason, losers with content hashes, junk, a safety column, and `needs-decision` side-by-sides for divergent duplicates. Walk the report, decide the conflicts, then `--apply` stores the winners in one commit (pushed when a remote is wired) — needs-decision clusters are skipped, never auto-decided. The source directory is never modified; nothing is auto-linked into your agents — keep your context lean and link deliberately via `add`.

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
| "Which of my skills are marketing skills?" | `/ninja cat` (then `cat assign` for the uncategorized ones) |
| "Which skills match <term>?" | `/ninja find <term>` |
| "This skill triggers constantly but I want it on demand" | `/ninja manual <name>` (invocable by name, never auto-triggered) |
| "Get this out of my context window entirely" | `/ninja off <name>` (or `off --category "…"` in bulk) |
| "This repo needs my content-setup skills" | `/ninja profile save content <names…>`, then `profile apply content` in the repo |
| "Show me Nils's skills as a bundle" | `/ninja collection save nils <names/prefixes…>`, then `cat @nils` |
| Landscape feels off | `/ninja status`, then `/ninja doctor` |
| An updated copy of a stored skill shows up | `/ninja diff`, then `/ninja add` |

## Status

🚧 **Early — v1.0 command surface implemented; v1.1 bulk ingest + status page; v1.2 category catalog; v1.3 availability layer; v1.4 visible canonical store live.** v1.0 is live: `init` (bootstrap + scan), `status`, `doctor`, `add` (safety check, stamping, commit + push), `diff`. The v1.1 `ingest` pipeline is live end to end — classification, deterministic cluster resolution (winners / losers / needs-decision with side-by-sides), prompt wrapping, the safety column, and `--apply` (store the winners with provenance in one commit + push, idempotent re-ingest) ([ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)) — and the v1.1 static HTML status page (`page`) renders the inventory as one self-contained offline file ([ADR-0011](./docs/adr/0011-static-html-status-page.md)). The v1.2 category catalog is live: `cat` groups the landscape by category, `cat assign` stamps categories onto stored skills, and the page groups by category ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md)). The v1.3 availability layer is live: `on`/`off`/`manual` with uniform selectors and two-phase apply, the per-tier mechanisms (Personal unlink + stamps with `activation_text` preservation; External ZCode-config disable with an ownership ledger), `find`, `profile save/list/forget/apply/lift`, inventory schema v4 (the canonical store is a scan root, so Off skills stay visible), and the page's interactive cockpit ([ADR-0014](./docs/adr/0014-availability-layer.md)). The v1.4 visible canonical store is live: `~/skill-ninja-store` as the default, `init --store <name|path>` name/path selection with plain-language switch reporting, and fresh-store seeding (README + initial commit) ([ADR-0016](./docs/adr/0016-visible-canonical-store.md)). The skill is invoked as `/ninja` (e.g. `/ninja init`). See [`SPEC.md`](./SPEC.md), [`CONTEXT.md`](./CONTEXT.md), and [`docs/adr/`](./docs/adr).

## Install

```bash
npx skills add MarcoHerten/skill-ninja
```

Distribution via [skills.sh](https://skills.sh) (`npx skills`) — multi-agent targeting, global vs project scope, and hash-based updates come for free. The same routine installs the skills Skill Ninja then watches over.

## Update

Skill Ninja never updates itself — updating is [skills.sh](https://skills.sh)'s job, exactly like installing. Refresh every skills.sh-installed skill (Skill Ninja included) with:

```bash
npx skills update
```

The update is hash-based — only skills whose content changed are rewritten — across all agents skills.sh targets. For a project-scoped install, run it from that project's directory. Afterwards run `/ninja init` so the cached inventory — and with it `/ninja status` and `/ninja page` — reflects the new versions: Skill Ninja ships its own `version` / `updated` stamps in the `SKILL.md` frontmatter, bumped each release.

## Roadmap

- **v1.0** ✅ — `init`, `status`, `doctor`, `add` (+ safety check), `diff`
- **v1.1** ✅ — `ingest` (bulk pipeline for messy skill/prompt directories — [ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)); static HTML status page ([ADR-0011](./docs/adr/0011-static-html-status-page.md))
- **v1.3** ✅ — availability layer: `on`/`off`/`manual`, `find`, `profile`, inventory v4, the page cockpit ([ADR-0014](./docs/adr/0014-availability-layer.md))
- **v1.3.1** ✅ — collections: personal config-side filters for `cat`/`find`/page/`--collection` ([ADR-0015](./docs/adr/0015-collections-are-config-side.md))
- **v1.4** ✅ — visible canonical store: `~/skill-ninja-store` default, `init --store <name|path>`, seeded README + initial commit ([ADR-0016](./docs/adr/0016-visible-canonical-store.md))

## Design principles

- **Local-first** — your skills stay on your machine; the only network is the optional Git remote.
- **One source of truth per tier** — a canonical store for personal skills (linked into each agent's root), and skills.sh's lockfile for the skills it installed. Skill Ninja audits across both.
- **Agent-native** — operated via slash commands in your coding agent, not a separate app.
- **Safe by default** — a lightweight safety check on every incoming skill.

## License

MIT
