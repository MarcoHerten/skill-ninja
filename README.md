# Skill Ninja

> A caretaker for your AI agent's skills — see where every skill lives, keep the collection tidy, and take in new skills safely, even the ones that don't arrive through [skills.sh](https://skills.sh).

*(Deutsche Version: [README.de.md](./README.de.md))*

## The problem, in plain words

AI coding agents — Claude Code, Codex, Cursor, … — learn their tricks from **skills**: small instruction files that teach them a craft. How to write a press release. How to review code. How to plan a workshop.

One skill is a gift. Twenty are a job:

- They scatter across agents, project folders, and Obsidian vaults — some global, some per project.
- Some are real copies, some are just links (symlinks). Links break silently.
- Two versions of the same skill sit side by side, and nothing tells you which one actually runs.
- Whole skill packs arrive bundled inside **plugins**, in cache folders no skills view looks at.
- A friend sends you "v2" of a skill. What changed? Nobody wants to find out by hand.

If you live in the terminal, you might script your way around this. Everyone else manages the mess by hand — or gives up. Skill Ninja exists so nobody has to.

## What Skill Ninja does

Skill Ninja runs **inside your coding agent**, as slash commands, on top of the skills that [skills.sh](https://skills.sh) (or you) already put there.

The short version: **skills.sh installs skills. Skill Ninja looks after them.** One clear picture of your landscape, plus the tools to keep it healthy:

- **`/ninja init`** — looks at your machine: which agents are installed, where every skill lives — loose ones and plugin-bundled ones alike. No preparation needed — the config is created for you on first run. Also sets up your **skill store**, a plain, visible git repo at `~/skill-ninja-store` by default (your own name or path: `init --store <name|path>`).
- **`/ninja status`** — the inventory on one screen: which agent can reach which skill, real copy or link, global or project, duplicates, broken links, versions, and where each skill came from — skills bundled inside agent plugins included, shown with the plugin they belong to.
- **`/ninja cat`** — your catalog: browse skills grouped by category (each with its one-line description) or filter by a term. `cat assign` files an uncategorized skill. Categories live in the skill's own frontmatter, never in a hand-maintained list ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md)) — and the status page groups by category too.
- **`/ninja page`** — the same inventory as a website: one self-contained HTML file at `~/.skill-ninja/status.html`. No server, no external assets, no network. Since v1.3 it's a small cockpit: search, filters, and checkboxes that build a copyable `ninja … --apply` command. The page itself never executes anything — the engine stays behind `--apply` ([ADR-0011](./docs/adr/0011-static-html-status-page.md)). Directly behind every skill name sits a `copy` button: one click puts the skill's full `SKILL.md` on your clipboard — paste it into any LLM chat (Claude, ChatGPT, Gemini, …) to use the skill there.
- **`/ninja doctor`** — finds broken links, duplicate spreads, and orphaned copies, and proposes a repair for each. Nothing is touched until you approve: re-run with `--apply` to execute the fixes you agreed to.
- **`/ninja add`** — one skill that didn't come through skills.sh (from a friend, a download, or bare prompt text): safety check, diff against what you already have, origin + hash stamp, a human-readable `CHANGELOG.md`, and the install itself.
- **`/ninja ingest`** — a whole messy directory at once: an export, a prompt library, a folder of near-duplicates. Everything gets classified, the variants clustered, and one winner per cluster proposed — with reasons. Divergent twins you decide yourself; the rest goes into the store in one commit. The source folder is never touched.
- **`/ninja on` / `off` / `manual`** — your lever on the context window. `off` unloads a skill everywhere. `manual` keeps it one slash away but stops it from auto-triggering. `on` brings it back — and doubles as install-on-demand for skills that are stored but not linked ([ADR-0014](./docs/adr/0014-availability-layer.md)).
- **`/ninja find`** — search your inventory by skill name, description, or category.
- **`/ninja profile`** — named skill sets per purpose ("the content setup", "the code setup"): save the member list once, `apply` it in any repo, `lift` it again when you leave.
- **`/ninja collection`** — named personal filters over the landscape ("everything from Nils"), usable in `cat`, `find`, the page dropdown, and bulk `on`/`off`/`manual`.
- **`/ninja diff`** — "my friend sent v2 — what's new?" Shows what actually changed since you stored the skill, or against the skills.sh source.

### Where your skills live

Your **personal** skills live in one visible place: the **skill store**, a normal git repository in your home directory (`~/skill-ninja-store` by default). You can open it, read it, browse its history. Push it to a private GitHub repo and you get off-machine backup plus a per-skill change log — every Skill Ninja action lands as a commit that answers "what changed on this skill, and when?".

Skills you installed via skills.sh stay owned by skills.sh — Skill Ninja watches over them too, it just doesn't re-link them. And skills bundled inside agent **plugins** stay owned by the plugin system — inventoried like everything else, never touched.

## Ready for Agent Plugins

Agents don't only read loose skills — they read **plugins**, and plugins bundle skills of their own. [Agent Plugins 1.0.0](https://developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/) — the open packaging spec maintained by **Amazon**, **Cursor**, **Microsoft**, **OpenAI**, and **Vercel**, joined by **Google** in 2026 — standardizes that bundle: a directory with a `plugin.json` manifest, its skills in `skills/`, tools and client extras alongside.

Skill Ninja is ready for it ([ADR-0018](./docs/adr/0018-plugin-owned-skills.md)):

- **Plugin-bundled skills show up in your inventory.** `status`, `page`, `cat`, and `find` list them with the plugin they belong to — "where every skill lives" includes the plugin channel. The spec layout is recognized as-is: a plugin in the Agent Plugins 1.0.0 format is discovered and attributed by its manifest name, today.
- **Nothing inside a plugin is ever touched.** Plugins are your agent's plugin system's business — Skill Ninja audits them the way it audits skills.sh installs: no repairs, no re-links, no availability switches. (A plugin caching several versions of the same skill is the plugin manager's spread, not your duplicate.)

The plugin roots currently cover the caches of Claude Code (`~/.claude/plugins/cache`) and ZCode (`~/.zcode/cli/plugins/cache`) — the spec deliberately defines no install location, so the map grows as clients adopt the format.

## Quick start

The whole product runs inside your coding agent as slash commands. This is the intended workflow — from install to a clean, versioned skill landscape in a few minutes:

```
install (once, global)
   │
   ▼
npx skills add -g MarcoHerten/skill-ninja       — Skill Ninja arrives as a global skill
   │
   ▼
/ninja init                                      — creates the config + your skill store
   │
   ▼
/ninja status  ·  /ninja page                    — the whole landscape at a glance
   │
   ├─► /ninja doctor --apply                     — repair broken links and duplicates
   ├─► git remote add … + push                   — private backup + browsable history
   │
   ▼
/ninja add  ·  /ninja ingest  ·  /ninja diff     — day to day
```

### 1. Install (once, globally)

The two `npx` commands in this README run in a **terminal**. No terminal open yet?

- **Mac:** press `⌘ + Space`, type `Terminal`, hit Enter — or find it under *Applications → Utilities*.
- **Windows:** press the **Windows** key, type `Terminal` (or `PowerShell`), hit Enter.

The only prerequisite is [Node.js](https://nodejs.org) — `npx` ships with it.

```bash
npx skills add -g MarcoHerten/skill-ninja
```

The `-g` makes it a **global skill** (user-level) — skills.sh's default is project-level, and Skill Ninja is the one skill you want everywhere: `/ninja` then works in every project and watches over your whole machine, not a single repo. And yes — Skill Ninja is itself a skill. It arrives through the same door it later guards.

### 2. Take stock: `init`, then `status`

```
/ninja init
/ninja status
```

`init` needs no preparation. It discovers which coding agents live on your machine, finds every skill across agent roots, Obsidian vaults, and project directories, and sets up the config (`~/.skill-ninja/config.json`) plus your skill store — seeded with a README and an initial commit, so it's presentable from the first push. On first run your agent proposes the default store name and asks whether you'd like your own (a bare name like `my-skills`, or a path like `~/code/skill-store`, via `init --store`). Re-running `init` never renames or moves an existing store.

`status` then shows the whole landscape — duplicates, broken symlinks, versions, origins. Re-run it whenever things change; filters like `/ninja status --duplicates` narrow the view.

Prefer a browser? `/ninja page` writes the same view as a self-contained HTML file and tells you where.

**Keep the status page findable:** it lives at `~/.skill-ninja/status.html`, and `page` rewrites that file on every run. A symlink somewhere visible therefore never goes stale:

```bash
ln -s ~/.skill-ninja/status.html ~/Desktop/skill-ninja-status.html
```

### 3. Clean up: `doctor`

```
/ninja doctor
```

Detects broken links, duplicate spreads, and orphaned copies — one proposed repair each. Everything waits for your approval: re-run with `--apply` to execute the fixes you agreed to.

### 4. Turn on versioning (recommended, once)

Every skill Skill Ninja stores is committed to the store repo. For off-machine backup and browsable history, create a **private** GitHub repo and wire it up:

```bash
git -C ~/skill-ninja-store remote add origin git@github.com:<you>/skill-ninja-store.git
```

That's the intended setup: **one visible repo, pushed to a private remote** — `add`, `ingest --apply`, `cat assign`, and availability switches all land as commits, so the log answers "what changed on this skill and when".

Keep that repo private — personal skills often carry company context. No remote? Skill Ninja still commits locally and skips pushing silently.

### 5. Day to day: one skill arrives → `add`

```
/ninja add <folder|file|zip|repo>
```

The curated path for a single skill that didn't come through skills.sh: safety check, diff against any stored version, origin + content-hash stamp, linking into your agent roots, commit + push. Bare prompt text works too (`--prompt`), and `--from` records who sent it.

### 6. A whole messy directory → `ingest`

```
/ninja ingest ~/Downloads/skills-export
```

The bulk path. The export that contains the same skill as a folder, a `.zip`, a `.skill`, *and* a `.skill.zip`. The prompt library that was never skills at all. The dry run classifies every item, clusters the variants, and reports the proposal: one winner per cluster with its reason, losers with content hashes, junk, a safety column, and side-by-sides for the divergent duplicates no rule can resolve. You walk the report and decide the conflicts; `--apply` stores the rest in one commit (pushed when a remote is wired). Needs-decision clusters are skipped, never auto-decided. The source directory is never modified, and nothing is auto-linked into your agents — keep your context lean and link deliberately via `add`.

### 7. Something changed → `diff`

```
/ninja diff <name> <candidate>
```

The comparison runs over the skill body, so bookkeeping churn — stamps, hashes — never shows up as a "change".

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

🚧 **Early — and everything below is live, up to v1.6.**

- **v1.0** — `init` (bootstrap + scan), `status`, `doctor`, `add` (safety check, stamping, commit + push), `diff`
- **v1.1** — the bulk `ingest` pipeline ([ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)); the offline status `page` ([ADR-0011](./docs/adr/0011-static-html-status-page.md))
- **v1.2** — the category catalog: `cat`, `cat assign`, category grouping in status and page ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md))
- **v1.3** — the availability layer: `on`/`off`/`manual` with uniform selectors and two-phase apply, `find`, `profile`, inventory v4, the page cockpit ([ADR-0014](./docs/adr/0014-availability-layer.md))
- **v1.3.1** — collections as personal filters for `cat`/`find`/page/`--collection` ([ADR-0015](./docs/adr/0015-collections-are-config-side.md))
- **v1.4** — the visible canonical store: `~/skill-ninja-store` as the default, `init --store`, seeded README + first commit ([ADR-0016](./docs/adr/0016-visible-canonical-store.md))
- **v1.5** — traveling bundles: collections & profiles live store-side (`<store>/collections.json` / `profiles.json`), travel with the store repo, and come back on a fresh machine by cloning the store + `init` ([ADR-0017](./docs/adr/0017-collections-and-profiles-travel-with-the-store.md))
- **v1.6** — plugin awareness: skills bundled inside agent plugins (Agent Plugins 1.0.0 layout and the pre-spec caches) are inventoried as plugin-owned — shown everywhere, touched nowhere ([ADR-0018](./docs/adr/0018-plugin-owned-skills.md))

The skill is invoked as `/ninja` (e.g. `/ninja init`). More detail in [`SPEC.md`](./SPEC.md), [`CONTEXT.md`](./CONTEXT.md), and [`docs/adr/`](./docs/adr).

## Install

```bash
npx skills add -g MarcoHerten/skill-ninja
```

The `-g` flag installs Skill Ninja **globally** (user-level), so `/ninja` works in every project — that's the recommended setup. Drop it only if you deliberately want Skill Ninja scoped to a single repo, which is skills.sh's default. Distribution via [skills.sh](https://skills.sh) (`npx skills`) — multi-agent targeting and hash-based updates come for free. The same routine installs the skills Skill Ninja then watches over.

## Update

Skill Ninja never updates itself — updating is [skills.sh](https://skills.sh)'s job, exactly like installing. Refresh every skills.sh-installed skill (Skill Ninja included) with:

```bash
npx skills update
```

The update is hash-based: only skills whose content actually changed are rewritten. For a global install, run it outside any project directory (or pass `-g`); for a project-scoped install, run it from that project's directory. Afterwards run `/ninja init`, so the cached inventory — and with it `/ninja status` and `/ninja page` — reflects the new versions: Skill Ninja ships its own `version` / `updated` stamps in the `SKILL.md` frontmatter, bumped each release.

## Roadmap

- **v1.0** ✅ — `init`, `status`, `doctor`, `add` (+ safety check), `diff`
- **v1.1** ✅ — `ingest` (bulk pipeline for messy skill/prompt directories — [ADR-0009](./docs/adr/0009-bulk-ingest-pipeline.md), [ADR-0010](./docs/adr/0010-wrap-prompts-into-skills.md)); static HTML status page ([ADR-0011](./docs/adr/0011-static-html-status-page.md))
- **v1.2** ✅ — category catalog: `cat` groups the landscape, `cat assign` stamps categories into the skill frontmatter ([ADR-0013](./docs/adr/0013-category-stamps-and-catalog.md))
- **v1.3** ✅ — availability layer: `on`/`off`/`manual`, `find`, `profile`, inventory v4, the page cockpit ([ADR-0014](./docs/adr/0014-availability-layer.md))
- **v1.3.1** ✅ — collections: personal filters for `cat`/`find`/page/`--collection` ([ADR-0015](./docs/adr/0015-collections-are-config-side.md))
- **v1.4** ✅ — visible canonical store: `~/skill-ninja-store` default, `init --store <name|path>`, seeded README + initial commit ([ADR-0016](./docs/adr/0016-visible-canonical-store.md))
- **v1.5** ✅ — traveling bundles: collections & profiles move store-side (`<store>/collections.json` / `profiles.json`), committed with the store, restored on a fresh machine by clone + `init` ([ADR-0017](./docs/adr/0017-collections-and-profiles-travel-with-the-store.md))
- **v1.6** ✅ — plugin awareness: agent plugin caches become scan roots, bundled skills are audited as plugin-owned (Agent Plugins 1.0.0-ready) ([ADR-0018](./docs/adr/0018-plugin-owned-skills.md))

## Design principles

- **Local-first** — your skills stay on your machine; the only network is the optional Git remote.
- **One source of truth per tier** — a canonical store for personal skills (linked into each agent's root), skills.sh's lockfile for the skills it installed, and the agent's plugin system for plugin-bundled skills. Skill Ninja audits across all three.
- **Agent-native** — operated via slash commands in your coding agent, not a separate app.
- **Safe by default** — a lightweight safety check on every incoming skill, and bulk actions stay dry runs until you pass `--apply`.

## License

MIT
