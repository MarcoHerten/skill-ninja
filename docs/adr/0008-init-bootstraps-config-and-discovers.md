# init bootstraps configuration and discovers the skill landscape

`init` is Skill Ninja's single front door. On a fresh machine it does **not** require a pre-existing config — it creates one. It runs in phases: **discover → seed → scan**.

**Discover (no config needed)** — probe the machine for what is there:

- **Agent roots** — existence-probe each known agent root (skills.sh's conventions). An agent counts as installed when its root directory exists; only installed agents are seeded, and only they are later audited for reachability (per the audit model: detected agents, not all 76).
- **Obsidian vaults** — read Obsidian's vault registry and treat each `vaults[*].path` as a vault to scan. Paths by platform: `~/Library/Application Support/obsidian/obsidian.json` (macOS), `%APPDATA%/obsidian/obsidian.json` (Windows), `~/.config/obsidian/obsidian.json` (Linux). Absent file ⇒ no vaults (graceful).
- **Project dirs** — configured project working directories (none until the user adds them).

**Seed** — write `~/.skill-ninja/config.json` from the discovery: detected agents, detected vaults, the default canonical store path.

**Scan** — walk every configured scan root (agent roots, vaults, project dirs) for skills, read any `skills-lock.json` for skills.sh attribution, and write the cached inventory — as before.

This replaces the previous behaviour where `init` errored on a missing config and pointed the user at hand-writing JSON — which broke the non-expert promise and contradicted `config show` (they pointed at each other; neither created the file).

## Consequences

- `init` is idempotent and re-runnable; re-running re-discovers and re-seeds. This is **how config gets edited** (include/exclude agents/vaults) — there is no separate `config set` DSL. Ad-hoc edits are made by the agent writing `config.json` directly; re-running `init` refreshes from detection.
- The canonical store defaults to `~/.skill-ninja/store`; `init` creates the directory and runs `git init`. The private remote is a config field; `add` commits and pushes only if a remote is configured, else commits locally and silently skips push. First run works without a remote.
- The hardcoded `AGENT_ROOTS` map in `engine/agents.js` grows to skills.sh's known-agent conventions and is probed by existence, rather than treated as a fixed configured set.
