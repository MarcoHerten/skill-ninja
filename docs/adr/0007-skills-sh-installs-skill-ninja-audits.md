# Skill Ninja delegates installation to skills.sh; owns audit, health, and provenance

Skill Ninja does not install skills. Installation — cloning, agent targeting, symlink/copy, security scanning — belongs to **skills.sh** (`npx skills`, Vercel Labs), which is also the channel Skill Ninja itself is installed through. Skill Ninja is the layer on top: it **audits** the skills already on the machine (`status`: per-agent reachability, copy-vs-symlink, global-vs-project, structural cleanliness), **heals** them (`doctor`), and **ingests with provenance** the skills that do *not* come through skills.sh — received, downloaded, or a bare prompt (`add`) — stamping `version` / `hash` / `provenance` into a canonical store that is a git repo with a private remote. `add` commits **and pushes**.

## Considered Options

- **Compete** — reimplement skills.sh's install (agent targeting, symlink/copy, security) inside Skill Ninja. Rejected: it is the SPEC's named "overloaded multi-tool" anti-pattern, and Skill Ninja's install would be permanently inferior (regex safety vs Gen + Socket + Snyk; 3 agents vs 76).
- **Wrap** — shell out to `npx skills` under Skill Ninja's own UX. Rejected: contradicts the standalone principle and couples Skill Ninja's core flow to skills.sh's CLI surface.

## Consequences

- `add` is scoped to the **non-skills.sh path** (received / downloaded / prompt). It no longer competes on agent targeting or security scanning — those are skills.sh's job for the skills skills.sh installs.
- **Two linking systems coexist, separated by tier:** skills.sh links the External skills it owns (recorded in `skills-lock.json`); Skill Ninja's `add` links the Personal skills it owns (store → agent roots). They must not stomp each other's bookkeeping; a name appearing in both populations is a `doctor` duplicate.
- `add` **pushes** to the private remote. This supersedes the earlier "commit locally, do not push" wording in `SPEC.md` and the v1 `add` implementation; the git step is commit + push (skipped silently if no remote is configured).
- The hardcoded 3-agent map in `engine/agents.js` is no longer the authority. Skill Ninja discovers agents from skills.sh's root conventions (existence-probe) for the audit.
