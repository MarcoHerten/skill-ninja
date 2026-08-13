# Engine bundled inside the skill

The Node engine lives **inside the skill** at `skills/skill-ninja/engine/`, not at the repo root.

## Decision

The skill ships as `skills/skill-ninja/SKILL.md` (the interface layer) **and** its deterministic Node engine at `skills/skill-ninja/engine/` (`cli.js`, `config.js`, `agents.js`). The `package.json` `bin` points at the engine entry; the `SKILL.md` runs the engine via `node <SKILL_DIR>/engine/cli.js <command>`.

## Why

SPEC.md specifies a hybrid form factor — "a skill (`SKILL.md`) bundled with a Node.js engine." Bundling the engine **inside the skill** is the faithful reading: the installed skill is self-contained, so the `npx skills add MarcoHerten/skill-ninja` artifact carries both the interface and the muscle in one unit. Putting the engine at the repo root would require a later move when the install layout is finalized, and would split the unit the spec wants kept together.

## Consequences

- Tests reference the engine by its path under `skills/` (see the harness's `ENGINE_PATH`). Moving the engine would update that one constant.
- Engine code is developed under `skills/skill-ninja/engine/`; later tickets (init/status/doctor/add/diff) add modules there.
