# Plugin-owned skills: Skill Ninja audits the plugin caches (Agent Plugins 1.0.0)

Agents get skills through a second channel besides skills.sh and the store: **plugins**. A plugin bundles skills (plus tools, MCP servers, client extensions) and is installed, updated, and removed by the agent's own plugin system — Claude Code's and ZCode's plugin caches already do this today, each holding dozens of bundled skills under a `skills/` subtree. **Agent Plugins 1.0.0** — the open, vendor-neutral packaging spec from the steering committee of Amazon, Cursor, Microsoft, OpenAI, and Vercel, which Google joined in August 2026 — standardized exactly that layout: a plugin is a directory with a `plugin.json` manifest (`$schema` + `name`), its skills in `skills/`, MCP servers in `mcp.json`, and client-specific extras in `com.example.*` reverse-domain directories. The spec deliberately defines no install location, distribution, or trust model — those stay with the clients.

Those bundled skills sat outside Skill Ninja's scan roots (plugin caches are not agent roots), so `status` under-reported where skills live — against the product's own promise. Skill Ninja now **audits the plugin caches**, the same stance it takes toward skills.sh (ADR-0007): plugin-bundled skills are **Plugin-owned** — discovered, attributed, and shown in every view, but never managed, linked, or switched by Skill Ninja.

## Decision

- **Plugin roots are scan roots of kind `plugin`.** `PLUGIN_ROOTS` (engine/agents.js) maps each agent family to its plugin cache under `$HOME (`~/.claude/plugins/cache`, `~/.zcode/cli/plugins/cache`), probed by existence per configured agent — the same convention as `AGENT_ROOTS` (ADR-0008). No config field: the roots derive from the configured agents. The map starts with the two verified cache conventions and grows as clients adopt the spec (which, by design, names no install location).
- **Only the cache tree is scanned.** A sibling `marketplaces/` tree holds the same plugins again as source clones; scanning both would count every bundled skill twice.
- **A plugin manifest bounds a plugin.** Inside a plugin root, a directory carrying one of `plugin.json` (Agent Plugins 1.0.0) / `.claude-plugin/plugin.json` / `.zcode-plugin-seed.json` / `package.json` is a boundary: the walk descends **only into its `skills/` subtree** — the spec's rule for where skill content lives — so `mcp.json`, `com.example.*` client dirs, commands, and agents can never surface as skills. Above a boundary (cache/marketplace/version wrapper dirs) the walk descends generically, carrying the nearest boundary's name.
- **Attribution is best-effort, never fatal.** The plugin name comes from the boundary's manifest (`name`, the seed's `plugin`, or the unscoped package name), falling back to the directory basename — stepping past a version segment, since both cache conventions nest as `cache/<marketplace>/<plugin>/<version>/`. A malformed manifest still bounds the plugin.
- **Plugin-tier occurrences are audit-only.** `tier: "plugin"`, `plugin: <name|null>` on the occurrence (inventory schema v5, additive). Mirroring ADR-0007's ownership rule: `doctor` proposes no repair for a group with any plugin occurrence; `on`/`off`/`manual` refuse plugin-owned names (a stamp or unlink inside the cache would be reverted on the next plugin update); an all-plugin version spread is not a duplicate (that spread belongs to the plugin manager), while a mixed personal+plugin spread stays visible as a duplicate — the user holds it twice — with the remedy running through the plugin channel, not Skill Ninja.

## Considered Options

- **Also scan the `marketplaces/` trees.** Rejected: every plugin would appear twice (cache + source clone), doubling the inventory and flagging phantom duplicates.
- **Read the agents' plugin registries** (`installed_plugins.json` & co.) instead of the filesystem. Rejected: the existence-probe over documented roots is the established, vendor-neutral discovery convention (ADR-0008); registry formats are internal and churn.
- **Support the rest of the Agent Plugins surface** (`mcp.json`, client extensions). Rejected: Skill Ninja's object is skills. Tool/server configuration stays out of scope.

## Consequences

- The inventory sees plugin-bundled skills — `status`, `page`, `cat`, `find`, and `doctor` all report them with their owning plugin. "Where every skill lives" now includes the plugin channel.
- The Agent Plugins 1.0.0 layout is recognized on disk as-is: a spec-conformant `plugin.json` + `skills/` directory dropped into any plugin root is discovered and attributed by its manifest name. As Google and the other steering-committee clients ship installs in this layout, they surface in the inventory without further changes — the basis for the public "ready for Agent Plugins" positioning.
- Inventory schema moves to v5 (additive: a `plugin` scan-root kind and two occurrence fields); consumers key off fields, never off completeness, so v4 caches remain readable until the next `init`.
- `status`'s duplicate verdict gains one carve-out (all-plugin spreads), documented in the code where `groupSkills` computes it.
